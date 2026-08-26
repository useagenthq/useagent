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

const SKIP_DIRS = new Set(["node_modules", ".next", "dist"]);

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
  "app/agent/artifacts/[id]/artifact-editor-surfaces.tsx": 1083,
  "components/agent-ui/rich-approval-card.tsx": 880,
  "components/chat/composer.tsx": 808,
  "components/chat/session-view.tsx": 1239,
  "components/chat/types.ts": 801,
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
