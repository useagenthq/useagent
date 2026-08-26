// Enforces the contract's independence: the provider-neutral sandbox contract is
// a pure leaf. Every `src/**` module may import only another module inside this
// package (a relative "./..." specifier). It must NOT reach into the useAgent
// backend/frontend, a concrete provider (Daytona/Cube), React/Next, Hono/Drizzle,
// a Node-only runtime, or a product path alias - any such leak would let a
// contract consumer transitively pull server code. The contract is types-only,
// so the expected steady state is ZERO import specifiers at all.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src");

/** Every import/export specifier that reaches outside this file. */
function specifiersOf(source: string): string[] {
  const out: string[] = [];
  // matches: import ... from "x"; export ... from "x"; import("x"); require("x")
  const re =
    /\b(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
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

describe("sandbox-contract import boundary", () => {
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

  test("no forbidden product/runtime/provider dependency appears anywhere in src", () => {
    // Belt-and-suspenders: even inside a relative path, none of these product,
    // heavy-runtime or concrete-provider tokens may appear as an import target.
    const forbidden = [
      "backend/", "frontend/", "react", "next", "hono", "drizzle",
      "@daytona", "daytona", "cube", "@/", "postgres", "better-auth", "node:",
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
