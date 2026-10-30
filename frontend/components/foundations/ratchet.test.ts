/**
 * Frontend quality ratchets.
 *
 * These EXTEND the repo's test-as-enforcement idiom (see
 * packages/agent-*\/test/import-boundary.test.ts and
 * components/shell/unified-shell-contract.test.ts) rather than introducing a
 * linter/formatter config. Each ratchet SNAPSHOTS the current debt and fails
 * only on NEW debt, so it is green on the tree it ships with and never forces a
 * reformat-the-world change. Shrinking a snapshot is always allowed.
 *
 * Homed under components/foundations/ (next to theme-tokens.test.ts and
 * DESIGN-RAMP.md) for two reasons: it rides the existing `bun test components`
 * CI job with no workflow change, and ratchet (a) enforces the design-system
 * boundary - components/base is the canonical kit, components/ui (AlignUI) is
 * legacy and must not be extended.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// components/foundations -> frontend
const FRONTEND_ROOT = resolve(import.meta.dir, "..", "..");
const MAX_LINES = 800;
const EM_DASH = String.fromCharCode(0x2014); // U+2014, built so this file authors no em dash glyph

// Build output is never source: `.next-build` (what `bun run build` writes, with
// standalone copies of first-party files under it) is skipped like the dev `.next`.
const SKIP_DIRS = new Set(["node_modules", ".next", ".next-build", "dist"]);

/** Every first-party .ts/.tsx under frontend/, excluding vendored trees
 *  (vendor/, the AlignUI kit components/ui/), build output and .d.ts shims.
 *  Test files ARE included here; individual ratchets skip them as needed. */
function firstPartyFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(FRONTEND_ROOT, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (rel === "vendor" || rel.startsWith("vendor/")) continue;
        if (rel === "components/ui" || rel.startsWith("components/ui/")) continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(rel);
      }
    }
  };
  walk(FRONTEND_ROOT);
  return out.sort();
}

const isTest = (rel: string) => /\.test\.tsx?$/.test(rel);
const read = (rel: string) => readFileSync(join(FRONTEND_ROOT, rel), "utf8");

/** Whole `import ... from "x"` / `export ... from "x"` statements + their
 *  specifier. Non-greedy `from` match keeps each statement self-contained. */
function importStatements(src: string): { spec: string; stmt: string }[] {
  const re = /\b(?:import|export)\b[\s\S]*?from\s*["']([^"']+)["']/g;
  const out: { spec: string; stmt: string }[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ spec: m[1]!, stmt: m[0] });
  return out;
}

/** Resolve an import specifier to a frontend-relative module path (no ext),
 *  or null for a bare package specifier. `@/x` maps to the frontend root. */
function resolveSpec(fromRel: string, spec: string): string | null {
  let abs: string;
  if (spec.startsWith("@/")) abs = resolve(FRONTEND_ROOT, spec.slice(2));
  else if (spec.startsWith(".")) abs = resolve(dirname(join(FRONTEND_ROOT, fromRel)), spec);
  else return null;
  return relative(FRONTEND_ROOT, abs).replaceAll("\\", "/");
}

// ---------------------------------------------------------------------------
// (a) AlignUI allowlist
// ---------------------------------------------------------------------------

/** First-party (non-test) files importing the AlignUI kit (@/components/ui/*)
 *  or its class-merge helper cnExt (@/utils/cn). */
function alignOffenders(): string[] {
  const offenders: string[] = [];
  for (const rel of firstPartyFiles()) {
    if (isTest(rel)) continue;
    let hit = false;
    for (const { spec, stmt } of importStatements(read(rel))) {
      const target = resolveSpec(rel, spec);
      if (target === "components/ui" || target?.startsWith("components/ui/")) hit = true;
      if (target === "utils/cn" && /\bcnExt\b/.test(stmt)) hit = true;
    }
    if (hit) offenders.push(rel);
  }
  return offenders.sort();
}

// The legacy AlignUI kit (components/ui) and its class-merge helper cnExt have
// been fully removed; components/base is the sole canonical kit. This list is
// now empty and must stay empty - any new import of components/ui or cnExt is
// forbidden debt.
const ALIGNUI_ALLOWLIST: string[] = [];

describe("AlignUI allowlist ratchet", () => {
  test("the removed components/ui tree cannot reappear", () => {
    expect(existsSync(join(FRONTEND_ROOT, "components/ui"))).toBeFalse();
  });

  test("allowlist is sorted, unique, and free of test files", () => {
    expect(ALIGNUI_ALLOWLIST).toEqual([...new Set(ALIGNUI_ALLOWLIST)].sort());
    expect(ALIGNUI_ALLOWLIST.filter(isTest)).toEqual([]);
  });

  test("no NEW first-party file imports the AlignUI kit or cnExt", () => {
    const offenders = alignOffenders();
    const allowed = new Set(ALIGNUI_ALLOWLIST);
    const newDebt = offenders.filter((f) => !allowed.has(f));
    if (newDebt.length) {
      console.log(
        "[align-ratchet] NEW AlignUI importers - use components/base instead, do not extend AlignUI:\n" +
          newDebt.join("\n"),
      );
    }
    const stale = ALIGNUI_ALLOWLIST.filter((f) => !offenders.includes(f));
    if (stale.length) {
      console.log(
        "[align-ratchet] allowlist entries that no longer import AlignUI (remove them):\n" +
          stale.join("\n"),
      );
    }
    expect(newDebt).toEqual([]);
    expect(stale).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) File-size ratchet
// ---------------------------------------------------------------------------

/** wc -l semantics: number of newline characters. */
function lineCount(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Recorded baselines for the files that are ALREADY over the 800-line cap. A
// number here may only SHRINK; new files get no baseline and are capped at 800.
const FRONTEND_SIZE_BASELINE: Record<string, number> = {
  "app/(library)/agent/artifacts/[id]/artifact-editor-surfaces.tsx": 1054,
  "components/agent-ui/rich-approval-card.tsx": 880,
  "components/chat/session-view.tsx": 990,
};

describe("file-size ratchet (frontend)", () => {
  test("no first-party .ts/.tsx exceeds max(800, its recorded baseline)", () => {
    const over: string[] = [];
    for (const rel of firstPartyFiles()) {
      if (isTest(rel)) continue;
      const n = lineCount(read(rel));
      const cap = Math.max(MAX_LINES, FRONTEND_SIZE_BASELINE[rel] ?? 0);
      if (n > cap) over.push(`${rel}: ${n} > ${cap}`);
    }
    if (over.length) {
      console.log(
        "[size-ratchet] over cap - split the file; if it is intentional legacy, record a baseline (shrink-only):\n" +
          over.join("\n"),
      );
    }
    expect(over).toEqual([]);
  });

  test("recorded baselines are still needed and not stale", () => {
    const loosen: string[] = [];
    for (const [rel, base] of Object.entries(FRONTEND_SIZE_BASELINE)) {
      if (!existsSync(join(FRONTEND_ROOT, rel))) continue;
      const n = lineCount(read(rel));
      if (n <= MAX_LINES) loosen.push(`${rel}: ${n} <= ${MAX_LINES} (drop the baseline)`);
      else if (n < base) loosen.push(`${rel}: ${n} < ${base} (lower the baseline)`);
    }
    if (loosen.length)
      console.log("[size-ratchet] baselines must be tightened:\n" + loosen.join("\n"));
    expect(loosen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (c) Em-dash scan
// ---------------------------------------------------------------------------

/** Line numbers where an em dash sits inside a single/double-quoted string
 *  literal. A small state machine so it ignores em dashes in comments, regex
 *  literals, and template literals (the latter embed GLSL/DSL source here).
 *  The house rule targets user-visible strings (labels, placeholders, aria),
 *  which are quoted literals. */
function emDashStringLines(src: string): number[] {
  const hits: number[] = [];
  let line = 1;
  let i = 0;
  let state: "code" | "line" | "block" | "str" | "regex" = "code";
  let quote = "";
  let prev = ""; // last significant code char, to tell regex from division
  let inClass = false;
  const regexAllowed = () => prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev);
  while (i < src.length) {
    const ch = src[i]!;
    const nx = src[i + 1];
    if (state === "code") {
      if (ch === "\n") {
        line++;
        i++;
        continue;
      }
      if (ch === "/" && nx === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (ch === "/" && nx === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        state = "str";
        quote = ch;
        i++;
        continue;
      }
      if (ch === "/" && regexAllowed()) {
        state = "regex";
        inClass = false;
        i++;
        continue;
      }
      if (!/\s/.test(ch)) prev = ch;
      i++;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        line++;
        state = "code";
      }
      i++;
      continue;
    }
    if (state === "block") {
      if (ch === "\n") line++;
      else if (ch === "*" && nx === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (state === "regex") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n") {
        line++;
        state = "code";
        i++;
        continue;
      }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        state = "code";
        prev = "/";
        i++;
        continue;
      }
      i++;
      continue;
    }
    // string or template literal
    if (ch === "\\") {
      if (nx === "\n") line++;
      i += 2;
      continue;
    }
    if (ch === "\n") {
      line++;
      i++;
      if (quote !== "`") state = "code";
      continue;
    }
    if (ch === quote) {
      state = "code";
      prev = quote;
      i++;
      continue;
    }
    if (ch === EM_DASH && quote !== "`") hits.push(line);
    i++;
  }
  return hits;
}

function emDashOffenders(): string[] {
  const files: string[] = [];
  for (const rel of firstPartyFiles()) {
    if (isTest(rel)) continue;
    if (emDashStringLines(read(rel)).length) files.push(rel);
  }
  return files.sort();
}

// Current debt only, shrink-only. app/dashboard/page.tsx dropped its em-dash
// placeholders in the dashboard-widget-grammar pass, so it is off the list.
// Remove an entry once the file is clean.
const EM_DASH_ALLOWLIST: string[] = [];

describe("em-dash ratchet (frontend)", () => {
  test("no NEW first-party file puts an em dash inside a string literal", () => {
    const offenders = emDashOffenders();
    const allowed = new Set(EM_DASH_ALLOWLIST);
    const newDebt = offenders.filter((f) => !allowed.has(f));
    if (newDebt.length) {
      console.log(
        "[em-dash-ratchet] new em dash in a string literal - use a hyphen or rephrase:\n" +
          newDebt.map((f) => `${f}: ${emDashStringLines(read(f)).join(",")}`).join("\n"),
      );
    }
    const stale = EM_DASH_ALLOWLIST.filter((f) => !offenders.includes(f));
    if (stale.length)
      console.log("[em-dash-ratchet] now-clean, remove from allowlist:\n" + stale.join("\n"));
    expect(newDebt).toEqual([]);
    expect(stale).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Arbitrary font sizes
// ---------------------------------------------------------------------------

// Text sizes come from the type tokens (styles/typography.css, DESIGN-RAMP.md):
// text-caption-1-* 12px, text-body-2-* 13px, text-body-* 14px, text-title-1-*
// 24px. An arbitrary size (`text-[11.5px]`, `text-[0.8rem]`, `[font-size:..]`)
// drifts from the measured density, so no file may add one (class strings;
// comments do not count, and inline styles and CSS are reviewed by hand, since
// chart and document models carry font sizes as data). The counts below
// are the debt that predates this ratchet (the work log among it): each may
// only shrink as its sizes move onto tokens, and is never a reason to add more.
/** Source with comments removed: a comment may name a forbidden example. */
const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const ARBITRARY_FONT_SIZE =
  /\btext-\[(?:length:[^\]]+|(?:\d+\.?\d*|\.\d+)(?:px|rem|em|pt|vw|vh|%)|(?:calc|clamp|min|max)\([^\]]*\))\]|\[font-size:[^\]]+\]/g;

const FONT_SIZE_BASELINE: Record<string, number> = {
  "app/(library)/secrets/secrets-manager.tsx": 1,
  "app/(workspace)/settings/api-keys-card.tsx": 1,
  "components/agent-ui/agent-loader.tsx": 2,
  "components/agent-ui/ai-sidebar.tsx": 1,
  "components/agent-ui/chat-app.tsx": 3,
  "components/agent-ui/citations.tsx": 4,
  "components/agent-ui/code-block.tsx": 2,
  "components/agent-ui/image-generation.tsx": 1,
  "components/agent-ui/message-bubble.tsx": 1,
  "components/agent-ui/message.tsx": 6,
  "components/agent-ui/plan-checklist.tsx": 1,
  "components/agent-ui/rich-approval-card.tsx": 1,
  "components/agent-ui/streaming-response.tsx": 2,
  "components/agent-ui/tool-approval.tsx": 1,
  "components/agent-ui/tool-result.tsx": 3,
  "components/ai/code-block.tsx": 2,
  "components/ai/context-card.tsx": 1,
  "components/ai/filter-table.tsx": 1,
  "components/ai/records-table.tsx": 2,
  "components/ai/streaming-text.tsx": 1,
  "components/ai/task-rows.tsx": 2,
  "components/application/calendar/calendar-month-grid.tsx": 4,
  "components/application/notification-center/template-notification-center-menu.tsx": 1,
  "components/artifacts/workpiece-proposal-review.tsx": 3,
  "components/base/avatar/avatar.tsx": 2,
  "components/chat/chat-citations.tsx": 1,
  "components/chat/orb-pill.tsx": 1,
  "components/chat/source-chip.tsx": 1,
  "components/chat/subagent-row.tsx": 4,
  "components/chat/terminal-pane.tsx": 1,
  "components/chat/tool-step-row.tsx": 2,
  "components/chat/turn-trace.tsx": 11,
  "components/prompt-kit/code-block.tsx": 1,
  "components/prompt-kit/markdown.tsx": 4,
  "components/session-ui/background-status-pill.tsx": 1,
  "components/session-ui/changed-files-tree.tsx": 11,
  "components/session-ui/context-window-meter.tsx": 5,
  "components/session-ui/file-diff-view.tsx": 3,
  "components/session-ui/git-chip.tsx": 1,
  "components/session-ui/queued-message-pill.tsx": 1,
  "components/session-ui/thread-row.tsx": 1,
  "components/session-ui/work-entry-row.tsx": 2,
  "components/session-ui/work-group.tsx": 2,
  "components/session-ui/worked-for-fold.tsx": 1,
  "components/session-ui/working-indicator.tsx": 1,
  "components/sidebar-kit/button.tsx": 1,
};

function arbitraryFontSizes(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rel of firstPartyFiles()) {
    if (isTest(rel)) continue;
    const n = withoutComments(read(rel)).match(ARBITRARY_FONT_SIZE)?.length ?? 0;
    if (n) counts.set(rel, n);
  }
  return counts;
}

describe("arbitrary font-size ratchet (frontend)", () => {
  test("the pattern catches arbitrary sizes and leaves tokens alone", () => {
    const hits = (s: string) => s.match(ARBITRARY_FONT_SIZE)?.length ?? 0;
    expect(
      hits('"text-[11px] text-[11.5px] text-[0.8rem] text-[.8rem] text-[12pt] text-[length:var(--size)] text-[clamp(1rem,2vw,2rem)] [font-size:13px]"'),
    ).toBe(8);
    expect(hits('"text-body-2-regular text-caption-1-medium text-[var(--x)] text-[#fff] w-[11px]"')).toBe(0);
  });

  test("no file adds an arbitrary font size; use the type tokens", () => {
    const grew: string[] = [];
    for (const [rel, n] of arbitraryFontSizes()) {
      const allowed = FONT_SIZE_BASELINE[rel] ?? 0;
      if (n > allowed) grew.push(`${rel}: ${n} > ${allowed}`);
    }
    if (grew.length)
      console.log(
        `[font-size-ratchet] new arbitrary font size - use text-caption-1-*, text-body-2-* or text-body-* (DESIGN-RAMP.md):\n${grew.join("\n")}`,
      );
    expect(grew).toEqual([]);
  });

  test("recorded font-size baselines are still needed and not stale", () => {
    const counts = arbitraryFontSizes();
    const loosen: string[] = [];
    for (const [rel, base] of Object.entries(FONT_SIZE_BASELINE)) {
      const n = counts.get(rel) ?? 0;
      if (n < base) loosen.push(`${rel}: ${n} < ${base} (${n === 0 ? "drop the entry" : "lower the baseline"})`);
    }
    if (loosen.length) console.log(`[font-size-ratchet] baselines must be tightened:\n${loosen.join("\n")}`);
    expect(loosen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Typography utilities exist
// ---------------------------------------------------------------------------

// A type class that names no utility (`text-body-2` without its weight) renders
// at whatever size it inherits, so a typo looks fine in one place and wrong in
// a popover. Utilities come from styles/typography.css (`--text-*`), the
// `@utility` rules in app/globals.css and the legacy scale in tailwind.config.ts.
const TYPE_UTILITY =
  /(?<![\w-])(?:[a-z0-9-]+:)*(text-(?:body|caption|title|headline|display|label|paragraph|subheading|footnote|callout|large-title)[a-z0-9-]*)(?![\w-])/g;

function definedTypeUtilities(): Set<string> {
  const defined = new Set<string>();
  for (const css of ["styles/typography.css", "app/globals.css"]) {
    const src = read(css);
    for (const m of src.matchAll(/--text-([a-z0-9-]+?)(?:--[a-z-]+)?\s*:/g)) defined.add(`text-${m[1]}`);
    for (const m of src.matchAll(/@utility\s+(text-[a-z0-9-]+)/g)) defined.add(`${m[1]}`);
  }
  // The legacy scale's keys: the `texts` object, however it is quoted or indented.
  const config = read("tailwind.config.ts");
  const start = config.indexOf("export const texts = {");
  const texts = start === -1 ? "" : config.slice(start, config.indexOf("\n};", start));
  for (const m of texts.matchAll(/^\s*['"]?([a-z0-9-]+)['"]?\s*:\s*\[/gm)) defined.add(`text-${m[1]}`);
  return defined;
}

describe("typography utilities exist (frontend)", () => {
  test("the defined set is read", () => {
    const defined = definedTypeUtilities();
    for (const name of ["text-body-regular", "text-body-2-medium", "text-caption-1-regular", "text-display-sm", "text-label-sm"])
      expect(defined.has(name)).toBe(true);
    expect(defined.has("text-body-2")).toBe(false);
  });

  test("every type class a source uses names a defined utility", () => {
    const defined = definedTypeUtilities();
    const missing: string[] = [];
    for (const rel of firstPartyFiles()) {
      if (isTest(rel)) continue;
      for (const m of withoutComments(read(rel)).matchAll(TYPE_UTILITY)) if (!defined.has(`${m[1]}`)) missing.push(`${rel}: ${m[1]}`);
    }
    if (missing.length)
      console.log(`[type-utility] not a utility - use text-caption-1-*, text-body-2-* or text-body-* with a weight:\n${missing.join("\n")}`);
    expect(missing).toEqual([]);
  });
});
