/**
 * Citation/link post-processing for LLM-generated wiki markdown.
 *
 * Ported to TypeScript from deepwiki-open (AsyncFuncAI/deepwiki-open, MIT
 * License, (c) 2024 Sheing Ng) — api/services/wiki/content.py. Turns the various
 * empty-parenthesis citation forms the model emits (`Sources: [path:lines]()`)
 * into real repository blob links, and normalizes the "Relevant source files"
 * <details> block. Pure functions.
 */

export interface RepoUrlContext {
  /** 'local' | 'github' | 'gitlab' | 'bitbucket' */
  type: string;
  repoUrl: string | null;
  defaultBranch: string;
}

/** Build a host-specific web URL for a repository-relative file path. Returns the
 *  bare path unchanged for local repos or unresolved hosts. */
export function generateFileUrl(filePath: string, ctx: RepoUrlContext): string {
  if (ctx.type === "local" || !ctx.repoUrl) return filePath;
  let hostname = "";
  try {
    hostname = (new URL(ctx.repoUrl).hostname || "").toLowerCase();
  } catch {
    return filePath;
  }
  if (hostname.includes("github")) return `${ctx.repoUrl}/blob/${ctx.defaultBranch}/${filePath}`;
  if (hostname.includes("gitlab")) return `${ctx.repoUrl}/-/blob/${ctx.defaultBranch}/${filePath}`;
  if (hostname.includes("bitbucket")) return `${ctx.repoUrl}/src/${ctx.defaultBranch}/${filePath}`;
  return filePath;
}

/** Backslash-escape '[' / ']' so paths render as plain Markdown link labels. */
function escapeLabel(s: string): string {
  return s.replace(/([[\]])/g, "\\$1");
}

/** Host-specific line anchor for an already-resolved file URL. */
function lineAnchor(url: string, start: string | undefined, end: string | undefined): string {
  if (!start) return "";
  let hostname = "";
  try {
    hostname = (new URL(url).hostname || "").toLowerCase();
  } catch {
    hostname = "";
  }
  if (hostname.includes("github")) return end ? `#L${start}-L${end}` : `#L${start}`;
  if (hostname.includes("gitlab")) return end ? `#L${start}-${end}` : `#L${start}`;
  if (hostname.includes("bitbucket")) return end ? `#lines-${start}:${end}` : `#lines-${start}`;
  return "";
}

/** Resolve `path[:start[-end]]` to a Markdown link, or null if unresolvable. */
function citationLink(
  path: string,
  start: string | undefined,
  end: string | undefined,
  ctx: RepoUrlContext,
): string | null {
  const url = generateFileUrl(path, ctx);
  if (url === path) return null; // local repo / unresolved host -> no web URL
  const linePart = start ? (end ? `:${start}-${end}` : `:${start}`) : "";
  const anchor = lineAnchor(url, start, end);
  return `[${escapeLabel(path)}${linePart}](${url}${anchor})`;
}

const DETAILS_RE =
  /<details>\s*<summary>\s*Relevant source files\s*<\/summary>[\s\S]*?<\/details>/i;
// Generic: any `[repo/path.ext:line]()` (files not in filePaths).
const GENERIC_RE = /\[([^[\]\s()]+?\.[A-Za-z0-9]+)(?::(\d+)(?:-(\d+))?)?\]\(\)/g;
// `[Sources: path:line]()` — prefix inside the bracket and/or a bare filename.
const PREFIXED_RE = /\[(Sources?|Source):\s*([^[\]\s():]+?)(?::(\d+)(?:-(\d+))?)?\]\(\)/gi;
// Redundant empty "()" left immediately after a completed link.
const STRAY_PARENS_RE = /(\]\([^)\s]+\))\(\)/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalize the <details> block and resolve the citation forms into links. */
export function postProcessWikiContent(
  content: string,
  filePaths: string[],
  ctx: RepoUrlContext,
): string {
  let processed = content;

  // 1. Rebuild the <details> block from the known file list.
  if (filePaths.length > 0) {
    const links = filePaths
      .map((p) => `- [${escapeLabel(p)}](${generateFileUrl(p, ctx)})`)
      .join("\n");
    const detailsBlock =
      "<details>\n" +
      "<summary>Relevant source files</summary>\n\n" +
      "The following files were used as context for generating this wiki page:\n\n" +
      `${links}\n` +
      "</details>";
    processed = DETAILS_RE.test(processed)
      ? processed.replace(DETAILS_RE, () => detailsBlock)
      : `${detailsBlock}\n\n${processed}`;
  }

  // 2. Resolve empty citations against the known filePaths (longest first).
  if (filePaths.length > 0) {
    const alternation = [...filePaths]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|");
    const citationRe = new RegExp(`\\[(${alternation})(?::(\\d+)(?:-(\\d+))?)?\\]\\(\\)`, "g");
    processed = processed.replace(citationRe, (whole, path, start, end) => {
      const link = citationLink(path, start, end, ctx);
      return link ?? whole;
    });
  }

  // 3. Resolve any remaining file-path-looking empty citations.
  processed = processed.replace(GENERIC_RE, (whole, path, start, end) => {
    const link = citationLink(path, start, end, ctx);
    return link ?? whole;
  });

  // 4. Resolve `[Sources: barename:line]()` via basename lookup.
  if (filePaths.length > 0) {
    const byBasename = new Map<string, string>();
    for (const p of filePaths) {
      const base = p.split("/").pop() ?? p;
      if (!byBasename.has(base)) byBasename.set(base, p);
    }
    processed = processed.replace(PREFIXED_RE, (whole, prefix, token, start, end) => {
      const fullPath = token.includes("/") ? token : byBasename.get(token);
      if (!fullPath) return whole;
      const link = citationLink(fullPath, start, end, ctx);
      if (link === null) return whole;
      return `${prefix}: ${link}`;
    });
  }

  // 5. Strip a redundant empty "()" after a completed link.
  processed = processed.replace(STRAY_PARENS_RE, "$1");

  return processed;
}
