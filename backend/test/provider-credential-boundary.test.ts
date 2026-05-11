import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const engineFiles = [
  "src/engines/acp-server.ts",
  "src/engines/opencode-server.ts",
  "src/engines/sandbox.ts",
] as const;

describe("provider credential trust boundary", () => {
  test("engine adapters cannot read or inject raw host provider credentials", () => {
    const source = engineFiles
      .map((path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))
      .join("\n");
    expect(source).not.toMatch(
      /process\.env\.(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY)/,
    );
    expect(source).not.toContain("hostProviderEnv");
  });

  test("every paid sandbox adapter fails closed without the gateway", () => {
    for (const path of engineFiles) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      expect(source).toContain("requires a configured provider gateway");
    }
  });
});
