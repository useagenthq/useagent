import { describe, expect, test } from "bun:test";
import { hostProviderEnv } from "./host-provider-env";

// The ONE rule for which host provider key reaches a sandbox (D6/#121). The point
// is MINIMAL surface: exactly the single key the engine+model reads, never more.
const FULL = {
  ANTHROPIC_API_KEY: "sk-ant-xxx",
  OPENROUTER_API_KEY: "sk-or-yyy",
  OPENAI_API_KEY: "sk-oai-zzz",
  DAYTONA_API_KEY: "dt-www",
} as const;

describe("hostProviderEnv (minimal host-key injection surface)", () => {
  test("opencode + OpenRouter slug -> ONLY OpenRouter (never Anthropic/OpenAI/Daytona)", () => {
    expect(hostProviderEnv("opencode", "anthropic/claude-haiku-4.5", { env: FULL })).toEqual({
      OPENROUTER_API_KEY: "sk-or-yyy",
    });
  });

  test("opencode + bare model name -> ONLY the direct Anthropic key", () => {
    expect(hostProviderEnv("opencode", "claude-haiku-4-5", { env: FULL })).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });
  });

  test("daytona alias behaves like opencode", () => {
    expect(hostProviderEnv("daytona", "openai/gpt-5", { env: FULL })).toEqual({
      OPENROUTER_API_KEY: "sk-or-yyy",
    });
  });

  test("claude injects ANTHROPIC ONLY in the dev-yolo escape hatch; prod gets nothing", () => {
    expect(hostProviderEnv("claude", "claude-opus-4.8", { env: FULL, allowHostKeys: true })).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });
    // never the OpenAI or OpenRouter key even in yolo
    expect(hostProviderEnv("claude", "claude-opus-4.8", { env: FULL, allowHostKeys: true })).not.toHaveProperty("OPENAI_API_KEY");
    expect(hostProviderEnv("claude", "claude-opus-4.8", { env: FULL, allowHostKeys: true })).not.toHaveProperty("OPENROUTER_API_KEY");
    // production (no bypass) injects no host key at all
    expect(hostProviderEnv("claude", "claude-opus-4.8", { env: FULL, allowHostKeys: false })).toEqual({});
    expect(hostProviderEnv("claude", "claude-opus-4.8", { env: FULL })).toEqual({});
  });

  test("codex injects OPENAI ONLY in dev-yolo; never the OpenRouter/Anthropic key", () => {
    expect(hostProviderEnv("codex", "gpt-5-codex", { env: FULL, allowHostKeys: true })).toEqual({
      OPENAI_API_KEY: "sk-oai-zzz",
    });
    expect(hostProviderEnv("codex", "gpt-5-codex", { env: FULL, allowHostKeys: false })).toEqual({});
  });

  test("claude-sdk alias behaves like claude", () => {
    expect(hostProviderEnv("claude-sdk", "claude-opus-4.8", { env: FULL, allowHostKeys: true })).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });
  });

  test("DAYTONA_API_KEY and other host creds are NEVER injected for any engine", () => {
    for (const engine of ["opencode", "claude", "codex", "daytona"]) {
      const out = hostProviderEnv(engine, "anthropic/claude-haiku-4.5", { env: FULL, allowHostKeys: true });
      expect(out).not.toHaveProperty("DAYTONA_API_KEY");
    }
  });

  test("a missing key is omitted, not injected empty", () => {
    expect(hostProviderEnv("opencode", "anthropic/claude", { env: { ANTHROPIC_API_KEY: "x" } })).toEqual({});
    expect(hostProviderEnv("opencode", "anthropic/claude", { env: { OPENROUTER_API_KEY: "" } })).toEqual({});
  });

  test("an unknown engine injects nothing (fail closed)", () => {
    expect(hostProviderEnv("mock", "whatever/model", { env: FULL, allowHostKeys: true })).toEqual({});
  });
});
