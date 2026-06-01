// The client must be browser/runtime-neutral (Section 1.1 / Slice 5): its `src/**` may
// import ONLY relative "./..." modules or the zero-dependency shared contract
// packages - never React, Next, a provider translator, backend, database, Daytona,
// or a Node-only runtime module. A leak here would let a UI pull server code into
// the browser through the client.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src");
const ALLOWED_BARE = new Set([
  "@useagent/agent-harness/canonical",
  "@useagent/artifact-workspace",
]);

function specifiersOf(source: string): string[] {
  const out: string[] = [];
  const re = /\b(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}
function tsFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...tsFilesUnder(full));
    else if (e.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

describe("agent-client import boundary", () => {
  const files = tsFilesUnder(SRC_DIR);

  test("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("every src import is relative './' or an allowed shared contract package", () => {
    const violations: { file: string; specifier: string }[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
        if (spec.startsWith(".")) continue;
        if (ALLOWED_BARE.has(spec)) continue;
        violations.push({ file, specifier: spec });
      }
    }
    if (violations.length) console.log("[import-boundary] violations:", violations);
    expect(violations).toEqual([]);
  });

  test("no React / Next / provider / backend / node runtime / db token appears in src imports", () => {
    const forbidden = [
      "react", "next", "@daytona", "daytona", "hono", "drizzle", "postgres",
      "better-auth", "backend/", "frontend/", "@/", "node:",
      "opencode", "acp", "@anthropic", "@openai",
    ];
    const violations: { file: string; specifier: string; token: string }[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
        if (ALLOWED_BARE.has(spec)) continue;
        const token = forbidden.find((t) => spec.includes(t));
        if (token) violations.push({ file, specifier: spec, token });
      }
    }
    if (violations.length) console.log("[import-boundary] forbidden:", violations);
    expect(violations).toEqual([]);
  });

  test("browser bundle: index.ts builds for the browser target with no node externals", async () => {
    const result = await Bun.build({ entrypoints: [join(SRC_DIR, "index.ts")], target: "browser" });
    if (!result.success) console.log("[browser-bundle] logs:", result.logs);
    expect(result.success).toBe(true);
  });
});
