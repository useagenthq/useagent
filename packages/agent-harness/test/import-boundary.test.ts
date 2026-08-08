// Enforces the package's independence (Section 1.1 / Slice 1 step 7): the
// server-side harness library must translate provider protocols WITHOUT importing
// Skynet backend/frontend source, React/Next, Hono/Drizzle, Daytona, Node-only
// runtimes, or product path aliases. Every `src/**` module may import only:
//   - another module inside this package (a relative "./..." specifier), or
//   - a Node built-in type-only module from a strict allowlist (none today).
// Anything else fails this test - which is the point: a leak into product code
// would let the browser-facing @skynet/agent-client transitively pull server code.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src");

/** Every import/export specifier that reaches outside this file. */
function specifiersOf(source: string): string[] {
  const out: string[] = [];
  // matches: import ... from "x"; export ... from "x"; import("x"); require("x")
  const re = /\b(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    out.push((m[1] ?? m[2] ?? m[3])!);
  }
  return out;
}

function tsFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...tsFilesUnder(full));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

describe("agent-harness import boundary", () => {
  const files = tsFilesUnder(SRC_DIR);

  test("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("no src module imports outside the package (only relative './' specifiers)", () => {
    const violations: { file: string; specifier: string }[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
        if (!spec.startsWith(".")) violations.push({ file, specifier: spec });
      }
    }
    if (violations.length) console.log("[import-boundary] violations:", violations);
    expect(violations).toEqual([]);
  });

  test("no forbidden product/runtime dependency appears anywhere in src", () => {
    // Belt-and-suspenders: even inside a relative path, none of these product or
    // heavy-runtime tokens may appear as an import target.
    const forbidden = [
      "backend/", "frontend/", "react", "next", "hono", "drizzle",
      "@daytona", "daytona", "@/", "postgres", "better-auth", "node:",
    ];
    const violations: { file: string; specifier: string; token: string }[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
        const token = forbidden.find((t) => spec.includes(t));
        if (token) violations.push({ file, specifier: spec, token });
      }
    }
    if (violations.length) console.log("[import-boundary] forbidden:", violations);
    expect(violations).toEqual([]);
  });
});
