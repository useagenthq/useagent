/**
 * Backend quality ratchets.
 *
 * Extends the repo's test-as-enforcement idiom (see
 * packages/agent-*\/test/import-boundary.test.ts) with a file-size ratchet for
 * backend/src and a dependency-law test. Each ratchet snapshots current debt and
 * fails only on NEW debt, so it is green on the tree it ships with. This runs in
 * the existing `backend -> bun run test` CI job (no filter, so it is picked up
 * automatically); it is pure fs work and needs no database.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// backend/test -> backend
const BACKEND_ROOT = resolve(import.meta.dir, "..");
const SRC_ROOT = join(BACKEND_ROOT, "src");
const REPO_ROOT = resolve(BACKEND_ROOT, "..");
const FRONTEND_DIR = join(REPO_ROOT, "frontend");
const BACKEND_DIR_PREFIX = join(REPO_ROOT, "backend") + "/";
const FRONTEND_DIR_PREFIX = FRONTEND_DIR + "/";
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const MAX_LINES = 800;

/** .ts/.tsx under `base` (excluding node_modules and .d.ts), relative to base. */
function tsFiles(base: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(relative(base, full).replaceAll("\\", "/"));
      }
    }
  };
  walk(base);
  return out.sort();
}

const isTest = (rel: string) => /\.test\.tsx?$/.test(rel);

/** Every import/export/dynamic-import/require specifier in a source file. */
function importSpecs(src: string): string[] {
  const re =
    /\b(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  const out: string[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

// ---------------------------------------------------------------------------
// File-size ratchet (backend/src)
// ---------------------------------------------------------------------------

/** wc -l semantics: number of newline characters. */
function lineCount(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Recorded baselines for files ALREADY over the 800-line cap. A number here may
// only SHRINK; new files get no baseline and are capped at 800. Test files are
// out of scope (they grow with fixtures and cases).
const BACKEND_SIZE_BASELINE: Record<string, number> = {
  "engines/opencode-server.ts": 2124,
  "engines/acp-server.ts": 1551,
  "runs/routes.ts": 1252,
  "memory/team-memory.ts": 1028,
  "worker.ts": 944,
};

describe("file-size ratchet (backend/src)", () => {
  test("no first-party .ts under src exceeds max(800, its recorded baseline)", () => {
    const over: string[] = [];
    for (const rel of tsFiles(SRC_ROOT)) {
      if (isTest(rel)) continue;
      const n = lineCount(readFileSync(join(SRC_ROOT, rel), "utf8"));
      const cap = Math.max(MAX_LINES, BACKEND_SIZE_BASELINE[rel] ?? 0);
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
    for (const [rel, base] of Object.entries(BACKEND_SIZE_BASELINE)) {
      const abs = join(SRC_ROOT, rel);
      if (!existsSync(abs)) continue;
      const n = lineCount(readFileSync(abs, "utf8"));
      if (n <= MAX_LINES) loosen.push(`${rel}: ${n} <= ${MAX_LINES} (drop the baseline)`);
      else if (n < base) loosen.push(`${rel}: ${n} < ${base} (lower the baseline)`);
    }
    if (loosen.length) console.log("[size-ratchet] baselines must be tightened:\n" + loosen.join("\n"));
    expect(loosen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dependency law
// ---------------------------------------------------------------------------

/** True if a relative specifier from `fromAbs` resolves under `dirPrefix`. */
function resolvesUnder(fromAbs: string, spec: string, dirPrefix: string): boolean {
  if (!spec.startsWith(".")) return false;
  const target = resolve(dirname(fromAbs), spec) + "/";
  return target.startsWith(dirPrefix);
}

describe("dependency law", () => {
  test("backend/src does not import the frontend", () => {
    const violations: string[] = [];
    for (const rel of tsFiles(SRC_ROOT)) {
      const abs = join(SRC_ROOT, rel);
      for (const spec of importSpecs(readFileSync(abs, "utf8"))) {
        if (spec.includes("frontend/") || resolvesUnder(abs, spec, FRONTEND_DIR_PREFIX)) {
          violations.push(`src/${rel} -> ${spec}`);
        }
      }
    }
    if (violations.length) console.log("[dep-law] backend importing frontend:\n" + violations.join("\n"));
    expect(violations).toEqual([]);
  });

  test("packages without their own boundary test do not import backend or frontend", () => {
    // agent-harness / agent-client / artifact-workspace / sandbox-contract
    // already ship a *boundary*.test.ts; skip them to avoid duplicating that
    // coverage and extend the law to the packages that have none.
    const hasBoundaryTest = (pkgDir: string) => {
      const testDir = join(pkgDir, "test");
      return (
        existsSync(testDir) &&
        readdirSync(testDir).some((f) => f.includes("boundary") && f.endsWith(".test.ts"))
      );
    };
    const covered: string[] = [];
    const checked: string[] = [];
    const violations: string[] = [];
    for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const pkgDir = join(PACKAGES_DIR, pkg.name);
      const srcDir = join(pkgDir, "src");
      if (!existsSync(srcDir)) continue;
      if (hasBoundaryTest(pkgDir)) {
        covered.push(pkg.name);
        continue;
      }
      checked.push(pkg.name);
      for (const rel of tsFiles(srcDir)) {
        const abs = join(srcDir, rel);
        for (const spec of importSpecs(readFileSync(abs, "utf8"))) {
          if (
            spec.startsWith("@/") ||
            spec.includes("backend/") ||
            spec.includes("frontend/") ||
            resolvesUnder(abs, spec, BACKEND_DIR_PREFIX) ||
            resolvesUnder(abs, spec, FRONTEND_DIR_PREFIX)
          ) {
            violations.push(`${pkg.name}/src/${rel} -> ${spec}`);
          }
        }
      }
    }
    console.log(
      `[dep-law] boundary-covered (skipped): ${covered.sort().join(", ") || "none"}; checked here: ${
        checked.sort().join(", ") || "none"
      }`,
    );
    if (violations.length) console.log("[dep-law] package importing backend/frontend:\n" + violations.join("\n"));
    expect(violations).toEqual([]);
  });
});
