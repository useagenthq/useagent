// Dependency law: packages never import apps, and this CLI depends on exactly ONE
// workspace package - @useagent/agent-client. Its src/** may import only relative
// modules, the agent-client (+ subpaths), the sanctioned MCP SDK, and node builtins.
// Any backend/frontend/@ path, or a second @useagent/* package, is a boundary break.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src");

function specifiersOf(source: string): string[] {
  const out: string[] = [];
  const re = /\b(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push((m[1] ?? m[2] ?? m[3])!);
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

function isAllowed(spec: string): boolean {
  if (spec.startsWith(".")) return true;
  if (spec === "@useagent/agent-client" || spec.startsWith("@useagent/agent-client/")) return true;
  if (spec === "@modelcontextprotocol/sdk" || spec.startsWith("@modelcontextprotocol/sdk/")) return true;
  if (spec.startsWith("node:")) return true;
  return false;
}

describe("cli import boundary", () => {
  const files = tsFilesUnder(SRC_DIR);

  test("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("src imports only agent-client, the MCP SDK, node builtins, or relative modules", () => {
    const violations: { file: string; specifier: string }[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
        if (!isAllowed(spec)) violations.push({ file, specifier: spec });
      }
    }
    if (violations.length) console.log("[cli import-boundary] violations:", violations);
    expect(violations).toEqual([]);
  });

  test("no app path and no second @useagent/* package are imported", () => {
    const forbidden = ["backend/", "frontend/", "@/", "@useagent/agent-harness", "@useagent/artifact"];
    const violations: { file: string; specifier: string; token: string }[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
        const token = forbidden.find((t) => spec.includes(t));
        if (token) violations.push({ file, specifier: spec, token });
      }
    }
    if (violations.length) console.log("[cli import-boundary] forbidden:", violations);
    expect(violations).toEqual([]);
  });
});
