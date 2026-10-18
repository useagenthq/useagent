/**
 * The agent docs (every tracked CLAUDE.md, AGENTS.md and the design ramp) name
 * paths, symbols and scripts that agents act on. This fails when a cited path
 * no longer exists in the tracked tree, a cited identifier is not declared
 * where the doc says it is, or a documented `bun run` names no script, so a
 * rename or a move cannot leave the docs pointing at nothing. Fix the doc in
 * the same commit as the code.
 *
 * A doc is read in scopes: a table cell, a list item, a paragraph, a fenced
 * line. Paths: words of inline code spans, relative link targets and `@file`
 * import lines, plus the words of fenced command lines (bun, bunx, cd). A word
 * is a path when it has a `/` and starts in a directory that exists next to the
 * doc or above it, or when it ends in a file extension; it resolves against the
 * doc's directory and each directory above it (area docs write paths relative
 * to their area). A bare file name must exist there, sit beside a file cited in
 * the same scope, or (in an area doc) name a file under the doc's directory.
 * Gitignored paths (CLAUDE.local.md, progress/) and absolute or home paths are
 * skipped.
 *
 * Symbols: a code span that is one camelCase or PascalCase (two humps or more)
 * identifier must be declared or exported in a file or directory cited in the
 * same scope; a SCREAMING_SNAKE one (often an env key) must appear there. When
 * its scope cites no file, it must appear in some source file. Write example
 * names in plain text or as `<name>`.
 *
 * Scripts: every `bun run <script>`, fenced or not, must name a script of the
 * package it runs in (see missingScripts).
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** Named on purpose although absent: things the docs forbid, and platform names. */
const ABSENT_ON_PURPOSE = new Set(["frontend/components/ui"]);
const NAMED_ON_PURPOSE = new Set(["forwardRef", "defaultProps", "AbortController"]);

function git(args: string[], stdin?: string): { code: number; out: string } {
  const run = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  return { code: run.exitCode, out: run.stdout.toString() };
}

const tracked = git(["ls-files", "-z"]).out.split("\0").filter(Boolean);
const files = new Set(tracked);
const dirs = new Set(tracked.flatMap((p) => p.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
const exists = (p: string) => files.has(p) || dirs.has(p);

const DOCS = tracked.filter((p) => /(^|\/)(CLAUDE|AGENTS|DESIGN-RAMP)\.md$/.test(p) && !p.includes("/sources/"));
const EXTENSION = /\.(ts|tsx|js|mjs|cjs|json|md|mdx|yml|yaml|sh|css|sql|toml|txt|lock|tf|html|svg)$/;
const dirOf = (doc: string) => (posix.dirname(doc) === "." ? "" : posix.dirname(doc));
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

/** The doc's directory, then each directory above it, ending at the root (""). */
function bases(doc: string): string[] {
  const out: string[] = [];
  for (let dir = posix.dirname(doc); ; dir = posix.dirname(dir)) {
    out.push(dir === "." ? "" : dir);
    if (dir === ".") return out;
  }
}

const join = (base: string, rel: string) => posix.normalize(base ? `${base}/${rel}` : rel).replace(/\/$/, "");

interface Scope {
  readonly text: string;
  readonly fenced: boolean;
}

/** A doc split into table cells, list items, paragraphs and fenced lines. */
function scopesOf(markdown: string): Scope[] {
  const out: Scope[] = [];
  let fenced = false;
  let current: string[] = [];
  const flush = () => {
    if (current.length) out.push({ text: current.join("\n"), fenced: false });
    current = [];
  };
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push({ text: line, fenced: true });
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "") flush();
    else if (trimmed.startsWith("|")) {
      flush();
      for (const cell of line.split(/(?<!\\)\|/)) out.push({ text: cell, fenced: false });
    } else if (/^(#|[-*] |\d+\. )/.test(trimmed)) {
      flush();
      current.push(line);
    } else current.push(line);
  }
  flush();
  return out;
}

const codeSpans = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim());

/** Fenced lines that run a command: their words are checked as paths. */
function commandWords(line: string): string[] {
  const words = line.trim().split(/\s+/);
  while (words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[0]!)) words.shift();
  return /^(bun|bunx|cd)$/.test(words[0] ?? "") ? words : [];
}

/** A word as a path: `bare` when it is a file name alone. */
function pathOf(token: string): { path: string; bare: boolean } | null {
  const t = token.replace(/:\d+(-\d+)?$/, "");
  if (/[\s<>{}$=|'"(),\\]/.test(t) || t.includes("://") || /^[@~/-]/.test(t) || /^(node|bun):/.test(t)) return null;
  const glob = t.indexOf("*");
  const path = (glob === -1 ? t : t.slice(0, glob).replace(/\/?[^/]*$/, "")).replace(/\/+$/, "");
  if (!path) return null;
  if (path.includes("/") || t.endsWith("/")) return { path, bare: false };
  return /^[\w@+-][\w.@+-]*$/.test(path) && EXTENSION.test(path) ? { path, bare: true } : null;
}

/** Where a cited word resolves in the tree, or null. */
function resolveCited(doc: string, word: string, siblings: readonly string[]): string | null {
  const cited = pathOf(word);
  if (!cited) return null;
  const hit = bases(doc).map((b) => join(b, cited.path)).find((p) => !p.startsWith("..") && (exists(p) || ABSENT_ON_PURPOSE.has(p)));
  if (hit) return hit;
  if (!cited.bare) return null;
  const sibling = siblings.map((s) => join(posix.dirname(s), cited.path)).find((p) => files.has(p));
  if (sibling) return sibling;
  const dir = dirOf(doc);
  return dir === "" ? null : (tracked.find((p) => p.startsWith(`${dir}/`) && posix.basename(p) === cited.path) ?? null);
}

/** Is this word a path citation that must resolve? */
function mustResolve(doc: string, word: string): boolean {
  const cited = pathOf(word);
  if (!cited) return false;
  if (cited.bare || EXTENSION.test(cited.path)) return true;
  return bases(doc).some((b) => exists(join(b, cited.path.split("/")[0]!)));
}

/** Paths a tracked .gitignore ignores (local excludes do not count, so a
 *  machine's own exclude file cannot hide a broken citation). */
function ignored(paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const out = git(["check-ignore", "--no-index", "--verbose", "--stdin"], `${paths.join("\n")}\n`).out;
  return new Set(
    out
      .split("\n")
      .map((line) => /^([^:]*):\d+:[^\t]*\t(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null && files.has(m[1]!) && m[1]!.endsWith(".gitignore"))
      .map((m) => m[2]!),
  );
}

const scopeWords = (scope: Scope) =>
  scope.fenced ? commandWords(scope.text) : codeSpans(scope.text).flatMap((s) => s.split(/\s+/));

/** The tracked files and directories a scope's words resolve to. */
function scopeTargets(doc: string, scope: Scope): string[] {
  const words = scopeWords(scope);
  const qualified = words.map((w) => resolveCited(doc, w, [])).filter((p): p is string => p !== null);
  return [...new Set([...qualified, ...words.map((w) => resolveCited(doc, w, qualified)).filter((p): p is string => p !== null)])];
}

function missingPaths(): string[] {
  const misses: { doc: string; token: string; candidates: string[] }[] = [];
  for (const doc of DOCS) {
    const markdown = read(doc);
    const dir = dirOf(doc);
    const links = [...markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "").matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
    const imports = [...markdown.matchAll(/^@(\S+)\s*$/gm)].map((m) => m[1]!);
    for (const target of [...links, ...imports]) {
      const rel = target.split("#")[0]!;
      if (!rel || /^[a-z]+:/i.test(rel)) continue;
      const path = join(dir, rel);
      if (!exists(path) && !ABSENT_ON_PURPOSE.has(path)) misses.push({ doc, token: target, candidates: [path] });
    }
    for (const scope of scopesOf(markdown)) {
      const siblings = scopeTargets(doc, scope);
      for (const word of scopeWords(scope)) {
        if (!mustResolve(doc, word) || resolveCited(doc, word, siblings)) continue;
        const path = pathOf(word)!.path;
        misses.push({ doc, token: word, candidates: bases(doc).map((b) => join(b, path)).filter((p) => !p.startsWith("..")) });
      }
    }
  }
  const skip = ignored(misses.flatMap((m) => m.candidates));
  return [
    ...new Set(
      misses
        .filter((m) => !m.candidates.some((p) => skip.has(p)))
        .map((m) => `${m.doc}: \`${m.token}\` does not exist${pathOf(m.token)?.bare ? " here (qualify the path)" : ""}`),
    ),
  ];
}

function symbolOf(token: string): string | null {
  const t = token.replace(/\(\)$/, "");
  if (!/^[A-Za-z_$][\w$]*$/.test(t) || NAMED_ON_PURPOSE.has(t)) return null;
  const camel = /^[a-z_$][a-z0-9_$]*[A-Z]/.test(t);
  const pascal = /^[A-Z][a-z0-9]+[A-Z]/.test(t);
  const screaming = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(t);
  return camel || pascal || screaming ? t : null;
}

const sourceText = (path: string): string =>
  files.has(path) ? read(path) : tracked.filter((p) => p.startsWith(`${path}/`) && !/\.(md|mdx|txt)$/.test(p)).map(read).join("\n");

const isScreaming = (symbol: string) => /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(symbol);
const mentions = (text: string, symbol: string) => new RegExp(`(?<![\\w$])${symbol}(?![\\w$])`).test(text);

/** A declaration or export of `symbol`, not a mention in a comment or string. */
function declares(text: string, symbol: string): boolean {
  const s = symbol.replace(/\$/g, "\\$");
  return new RegExp(
    `\\b(?:function\\*?|const|let|var|class|interface|type|enum)\\s+${s}(?![\\w$])|\\bexport\\s*(?:type\\s*)?\\{[^}]*(?<![\\w$])${s}(?![\\w$])[^}]*\\}|^\\s*(?:async\\s+)?${s}\\s*\\(`,
    "m",
  ).test(text);
}

function missingSymbols(): string[] {
  const misses: string[] = [];
  const anywhere = new Map<string, Set<string>>();
  for (const doc of DOCS) {
    for (const scope of scopesOf(read(doc))) {
      if (scope.fenced) continue;
      const symbols = codeSpans(scope.text).map(symbolOf).filter((x): x is string => x !== null);
      if (symbols.length === 0) continue;
      const targets = scopeTargets(doc, scope).filter((t) => !t.endsWith(".md"));
      for (const symbol of symbols) {
        if (targets.length === 0) anywhere.set(symbol, (anywhere.get(symbol) ?? new Set()).add(doc));
        else if (!targets.some((t) => (isScreaming(symbol) ? mentions : declares)(sourceText(t), symbol)))
          misses.push(`${doc}: \`${symbol}\` is not ${isScreaming(symbol) ? "in" : "declared in"} ${targets.join(", ")}`);
      }
    }
  }
  if (anywhere.size > 0) {
    const args = [...anywhere.keys()].flatMap((symbol) => ["-e", symbol]);
    const run = git(["grep", "-h", "-o", "-w", "-F", "-I", ...args, "--", ".", ":(exclude)*.md", ":(exclude)*.mdx", ":(exclude)*.txt"]);
    if (run.code > 1) throw new Error("git grep failed");
    const found = new Set(run.out.split("\n"));
    for (const [symbol, docs] of anywhere)
      if (!found.has(symbol)) misses.push(`${[...docs].join(", ")}: \`${symbol}\` appears in no source file`);
  }
  return [...new Set(misses)];
}

/** `bun run <script>` must name a script of the package it runs in: the
 *  directory of the last `cd <dir>` before it (on its line, or earlier in its
 *  fenced block; a `<placeholder>` means every directory there), else the root
 *  package when the text says "root" just before it, else the nearest
 *  package.json at or above the doc, else every package directly below the doc.
 *  Flags after `bun run` are skipped. A `bun run <file>` names a file instead. */
function missingScripts(): string[] {
  const scriptsOf = (dir: string): Set<string> | null => {
    const manifest = dir ? `${dir}/package.json` : "package.json";
    if (!files.has(manifest)) return null;
    const pkg = JSON.parse(read(manifest)) as { scripts?: Record<string, string> };
    return new Set(Object.keys(pkg.scripts ?? {}));
  };
  const childDirs = (dir: string) =>
    [...dirs].filter((d) => posix.dirname(d) === (dir || ".") && files.has(`${d}/package.json`));
  const misses: string[] = [];
  for (const doc of DOCS) {
    const dir = dirOf(doc);
    let fenced = false;
    let cdDir: string | undefined;
    for (const line of read(doc).split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        cdDir = undefined;
        continue;
      }
      if (!fenced) cdDir = undefined;
      for (const m of line.matchAll(/\bcd\s+([^\s&;`]+)|\bbun run (?:--cwd\s+(\S+)\s+)?(?:--?[a-z][\w-]*\s+)*([\w:./-]+)/g)) {
        if (m[1]) {
          cdDir = m[1];
          continue;
        }
        const [, , cwd, raw] = m;
        const script = raw!.replace(/[:.]+$/, "");
        const at = cwd ?? cdDir;
        const saysRoot = /\broot\s+`?$/i.test(line.slice(0, m.index));
        if (script.includes("/") || EXTENSION.test(script)) {
          const base = at ? join(dir, at) : dir;
          if (!exists(join(base, script)) && !exists(join(at ?? "", script))) misses.push(`${doc}: \`bun run ${script}\` names no file`);
          continue;
        }
        let candidates: string[];
        if (at && /<[^>]+>/.test(at)) {
          const parent = at.replace(/\/?<[^>]+>.*$/, "");
          candidates = childDirs(exists(parent) ? parent : join(dir, parent));
        } else if (at) {
          candidates = [exists(at) ? at : join(dir, at)];
        } else if (saysRoot) {
          candidates = [""];
        } else {
          const nearest = bases(doc).find((b) => scriptsOf(b) !== null);
          candidates = nearest !== undefined && scriptsOf(nearest)!.has(script) ? [nearest] : childDirs(dir);
        }
        const ok = candidates.length > 0 && candidates.every((c) => scriptsOf(c)?.has(script) ?? false);
        if (!ok) misses.push(`${doc}: \`bun run ${script}\` is not a script in ${candidates.join(", ") || "any package.json"}`);
      }
    }
  }
  return [...new Set(misses)];
}

test("the agent docs are found", () => {
  expect(DOCS).toContain("AGENTS.md");
  expect(DOCS).toContain("CLAUDE.md");
});

test("the checks catch what they promise", () => {
  expect(declares("export function settleRunTx() {}", "settleRunTx")).toBe(true);
  expect(declares('export { envSwitch } from "./env-values";', "envSwitch")).toBe(true);
  expect(declares("// settleRunTx used to live here", "settleRunTx")).toBe(false);
  expect(commandWords("TEST_DATABASE_URL=x bun test test/a.test.ts")).toEqual(["bun", "test", "test/a.test.ts"]);
  expect(scopesOf("| a `x` | b `y` |").map((s) => s.text.trim())).toEqual(["", "a `x`", "b `y`", ""]);
});

test("every path an agent doc cites exists", () => {
  const misses = missingPaths();
  if (misses.length) console.log(`[agent-docs] fix the doc or the path:\n${misses.join("\n")}`);
  expect(misses).toEqual([]);
});

test("every symbol an agent doc cites is declared where it says", () => {
  const misses = missingSymbols();
  if (misses.length) console.log(`[agent-docs] fix the doc or the symbol:\n${misses.join("\n")}`);
  expect(misses).toEqual([]);
});

test("every `bun run` an agent doc names is a script of its package", () => {
  const misses = missingScripts();
  if (misses.length) console.log(`[agent-docs] fix the command or the script:\n${misses.join("\n")}`);
  expect(misses).toEqual([]);
});
