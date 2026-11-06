import { posix } from "node:path";

const MAX_MARKDOWN_BYTES = 256 * 1024;
const MAX_OUTPUT_LINKS = 100;
const MAX_LINK_MARKERS = 4096;
const FILESYSTEM_ROOTS = /^\/(?:root|home|tmp|private|Users|workspace|mnt|opt|srv|app|var|work|etc|usr)(?:\/|$)/;

export interface OutputLink {
  readonly path: string;
  readonly image: boolean;
  readonly href: string;
}

/** Only links and images recognized by Bun's GFM parser declare output. */
export function explicitOutputLinks(markdown: string, workspaceRoot: string): OutputLink[] {
  if (Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) throw new Error("output Markdown is too large");
  let markers = 0;
  for (const character of markdown) {
    if (character === "[" && ++markers > MAX_LINK_MARKERS) throw new Error("output Markdown is too complex");
  }
  const links: OutputLink[] = [];
  const add = (href: string, image: boolean) => {
    const path = outputPath(href, workspaceRoot);
    if (path === null) return "";
    if (links.length === MAX_OUTPUT_LINKS) throw new Error("too many output links");
    links.push({ path, image, href });
    return "";
  };
  Bun.markdown.render(markdown, {
    link: (_children, { href }) => add(href, false),
    image: (_children, { src }) => add(src, true),
  });
  return links;
}

/** A code citation (path:line, path:line:col, path#L12, path#L12-L20) points
 *  at source a reply discusses, not a file it delivers. Review agents cited
 *  repo files this way and each finished run failed delivery. */
const CODE_CITATION = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/i;

function outputPath(destination: string, workspaceRoot: string): string | null {
  if (CODE_CITATION.test(destination)) return null;
  let path: string;
  if (/^file:/i.test(destination)) {
    path = destination.slice("file:".length);
    if (path.startsWith("//")) {
      if (!path.startsWith("///")) throw new Error("invalid local output URL");
      path = path.slice(2);
    }
    if (path.includes("?") || path.includes("#")) throw new Error("invalid local output URL");
    path = decodePath(path);
  } else if (/^sandbox:/i.test(destination)) {
    path = destination.slice("sandbox:".length);
    if (path.includes("?") || path.includes("#")) throw new Error("invalid local output URL");
    path = decodePath(path);
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(destination)
      || destination.startsWith("//")
      || destination.startsWith("#")
      || destination.startsWith("?")) return null;
    path = decodePath(destination);
    if (path.startsWith("/")) {
      const root = posix.resolve(workspaceRoot);
      const inWorkspace = root !== "/" && (path === root || path.startsWith(`${root}/`));
      if (!inWorkspace && !FILESYSTEM_ROOTS.test(path)) return null;
    }
    if (!path.startsWith("/")) path = posix.resolve(workspaceRoot, path);
  }
  if (!posix.isAbsolute(path) || path.length > 4096 || path.includes("\0")) {
    throw new Error("invalid local output path");
  }
  return path;
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function replaceOutputLinks(
  markdown: string,
  links: readonly OutputLink[],
  urls: ReadonlyMap<string, { readonly preview: string; readonly download: string }>,
): string {
  const replacements = new Map<string, string>();
  let changed = false;
  for (const link of links) {
    const url = urls.get(link.path);
    if (!url) throw new Error("missing published output URL");
    const replacement = link.image ? url.preview : url.download;
    replacements.set(`${link.image ? "image" : "link"}:${link.href}`, replacement);
    changed ||= link.href !== replacement;
  }
  if (!changed) return markdown;
  return renderMarkdown(markdown, replacements);
}

function renderMarkdown(markdown: string, replacements: ReadonlyMap<string, string>): string {
  const texts: string[] = [];
  const cells: Array<{ content: string; align?: "left" | "center" | "right" }> = [];
  const rows: string[][] = [];
  const textToken = (text: string) => `\0T${texts.push(text) - 1}\0`;
  const cellToken = (content: string, align?: "left" | "center" | "right") =>
    `\0C${cells.push({ content, align }) - 1}\0`;
  const rowToken = (children: string) => {
    rows.push([...children.matchAll(/\0C(\d+)\0/g)].map((match) => match[1]!));
    return `\0R${rows.length - 1}\0`;
  };
  const raw = (value: string) => value.replace(/\0T(\d+)\0/g, (_match, index) => texts[Number(index)]!);
  const escaped = (value: string) => value.replace(/\0T(\d+)\0/g, (_match, index) =>
    texts[Number(index)]!.replace(/([\\`*{}[\]()#+.!_<>|~\-])/g, "\\$1"));
  const destination = (href: string) => `<${href.replace(/\\/g, "%5C").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\n/g, "%0A")}>`;
  const title = (value?: string) => value === undefined ? "" : ` \"${value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"")}\"`;
  const fenced = (content: string, language?: string) => {
    const body = raw(content).replace(/\n$/, "");
    const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
    const fence = "`".repeat(longest + 1);
    return `${fence}${language ?? ""}\n${body}\n${fence}\n\n`;
  };
  const inlineCode = (content: string) => {
    const body = raw(content);
    const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
    const fence = "`".repeat(longest + 1);
    const pad = body.startsWith("`") || body.endsWith("`") || (body.startsWith(" ") && body.endsWith(" ")) ? " " : "";
    return `${fence}${pad}${body}${pad}${fence}`;
  };

  return Bun.markdown.render(markdown, {
    text: textToken,
    heading: (children, { level }) => `${"#".repeat(level)} ${escaped(children)}\n\n`,
    paragraph: (children) => `${escaped(children)}\n\n`,
    blockquote: (children) => `${escaped(children).trimEnd().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`,
    code: (children, meta) => fenced(children, meta?.language),
    codespan: inlineCode,
    strong: (children) => `**${escaped(children)}**`,
    emphasis: (children) => `*${escaped(children)}*`,
    strikethrough: (children) => `~~${escaped(children)}~~`,
    link: (children, meta) => `[${escaped(children)}](${destination(replacements.get(`link:${meta.href}`) ?? meta.href)}${title(meta.title)})`,
    image: (children, meta) => `![${escaped(children)}](${destination(replacements.get(`image:${meta.src}`) ?? meta.src)}${title(meta.title)})`,
    listItem: (children, meta) => {
      const marker = meta.ordered ? `${(meta.start ?? 1) + meta.index}.` : "-";
      const task = meta.checked === undefined ? "" : `[${meta.checked ? "x" : " "}] `;
      return `${marker} ${task}${escaped(children).trimEnd().replace(/\n/g, "\n  ")}\n`;
    },
    list: (children) => `${escaped(children).trimEnd()}\n\n`,
    hr: () => "---\n\n",
    th: (children, meta) => cellToken(escaped(children), meta?.align),
    td: (children, meta) => cellToken(escaped(children), meta?.align),
    tr: rowToken,
    thead: (children) => children,
    tbody: (children) => children,
    table: (children) => {
      const tableRows = [...children.matchAll(/\0R(\d+)\0/g)]
        .map((match) => rows[Number(match[1])]!.map((cell) => cells[Number(cell)]!));
      if (!tableRows[0]?.length) return "";
      const line = (row: typeof cells) => `| ${row.map((cell) => cell.content.replace(/\|/g, "\\|")).join(" | ")} |`;
      const separator = tableRows[0].map((cell) => ({
        content: cell.align === "center" ? ":---:" : cell.align === "right" ? "---:" : cell.align === "left" ? ":---" : "---",
      }));
      return `${line(tableRows[0])}\n${line(separator)}\n${tableRows.slice(1).map(line).join("\n")}\n\n`;
    },
    html: (children) => raw(children),
  }).trimEnd();
}
