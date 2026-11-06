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
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
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
  // Read-only and windowed thread routes live in runs/read-routes.ts.
  "runs/routes.ts": 1009,
  "memory/team-memory.ts": 1005,
  // Scripted mock execution and worker events live in focused worker modules.
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

// ---------------------------------------------------------------------------
// Product-name ratchet
// ---------------------------------------------------------------------------

/** The product's first name, in any case and with or without a separator. */
const FIRST_NAME = /sky[-_.]?net/gi;

// Files that keep the first name, and how often it appears in each. Every one
// holds a value already persisted or deployed under it; the reasons are in
// docs/architecture/legacy-identifiers.md. A count may only shrink, and a file
// not listed here may not mention the name at all.
const FIRST_NAME_ALLOWLIST: Record<string, number> = {
  "backend/src/artifacts/authoring.ts": 1,
  "backend/src/artifacts/publish.ts": 1,
  "backend/src/db/gateway-grants.ts": 1,
  "backend/src/dev-org.ts": 1,
  "backend/src/knowledge/gateway/approval-capability.ts": 1,
  "backend/src/knowledge/gateway/token.ts": 1,
  "backend/src/memory/explicit-memory.ts": 1,
  "backend/src/memory/team-memory.ts": 1,
  "backend/src/provider-connections/codex-app-server-pool.ts": 1,
  "backend/src/provider-gateway/token.ts": 1,
  "backend/src/sandboxes/cube-warm-pool-reconcile.ts": 1,
  "backend/src/sandboxes/label-compat.ts": 2,
  "backend/src/sandboxes/sandbox-names.ts": 1,
  "backend/src/secrets/crypto.ts": 1,
  "backend/src/security/runtime-secrets.ts": 1,
  "backend/src/wiki-gen/clone.ts": 2,
  "backend/test/fixtures/runtime-v2/codex-turn-provider-failure.json": 238,
  "backend/test/persisted-names.test.ts": 30,
  "deploy/local-sandbox/rootfs/home/user/Desktop/browser.desktop": 1,
  "docs/architecture/legacy-identifiers.md": 25,
  "frontend/app/(library)/knowledge/knowledge-brand.test.tsx": 1,
  "frontend/app/(library)/knowledge/knowledge-data.ts": 1,
  "memory/docker-compose.yml": 2,
  "memory/tdai-gateway.yaml": 1,
  "packages/agent-harness/src/canonical.ts": 7,
  "packages/agent-harness/test/fixtures/opencode-heavy.json": 1,
  "packages/sandbox-cube/src/provider.test.ts": 5,
  "packages/sandbox-cube/src/provider.ts": 3,
  "packages/sandbox-daytona/src/plugin.ts": 1,
};

/** Tracked files (including ones added with intent), relative to the repo root. */
function trackedFiles(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: REPO_ROOT });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  // lstat, not exists: a dangling symlink is still checked, a deleted file is skipped.
  return listed.stdout.toString().split("\0").filter((path) => path && lstatSync(join(REPO_ROOT, path), { throwIfNoEntry: false }));
}

/** A file's text, a symlink's target, or nothing for binary content. */
function searchableText(abs: string): string {
  if (lstatSync(abs).isSymbolicLink()) return readlinkSync(abs);
  const bytes = readFileSync(abs);
  return bytes.subarray(0, 8000).includes(0) ? "" : bytes.toString("utf8");
}

function firstNameCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rel of trackedFiles()) {
    const text = searchableText(join(REPO_ROOT, rel));
    const n = (rel.match(FIRST_NAME)?.length ?? 0) + (text.match(FIRST_NAME)?.length ?? 0);
    if (n > 0) counts.set(rel, n);
  }
  return counts;
}

describe("product-name ratchet", () => {
  const counts = firstNameCounts();

  test("the first name appears only in allowlisted files, no more often than recorded", () => {
    const over = [...counts]
      .filter(([rel, n]) => n > (FIRST_NAME_ALLOWLIST[rel] ?? 0))
      .map(([rel, n]) => `${rel}: ${n} > ${FIRST_NAME_ALLOWLIST[rel] ?? 0}`);
    if (over.length) {
      console.log(
        "[name-ratchet] use the product name; a value that is already persisted under the first name belongs in one named constant (docs/architecture/legacy-identifiers.md):\n" +
          over.join("\n"),
      );
    }
    expect(over).toEqual([]);
  });

  test("allowlist counts are exact", () => {
    const stale = Object.entries(FIRST_NAME_ALLOWLIST)
      .filter(([rel, n]) => (counts.get(rel) ?? 0) !== n)
      .map(([rel, n]) => `${rel}: ${counts.get(rel) ?? 0} (recorded ${n})`);
    if (stale.length) console.log("[name-ratchet] lower or drop these entries:\n" + stale.join("\n"));
    expect(stale).toEqual([]);
  });
});
