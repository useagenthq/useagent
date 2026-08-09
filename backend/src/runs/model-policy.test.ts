import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENCODE_MODEL,
  KIMI_K3_MODEL,
  defaultModelForEngine,
  isModelAllowedForEngine,
  OPENCODE_ALLOWED_MODELS,
} from "./model-policy";

describe("paid model policy", () => {
  test("uses engine-owned defaults", () => {
    expect(DEFAULT_OPENCODE_MODEL).toBe(KIMI_K3_MODEL);
    expect(defaultModelForEngine("opencode", {})).toBe(KIMI_K3_MODEL);
    expect(defaultModelForEngine("claude", {})).toBe("claude-opus-5");
    expect(defaultModelForEngine("codex", {})).toBe(DEFAULT_CODEX_MODEL);
    expect(
      defaultModelForEngine("codex", {
        CODEX_ALLOWED_MODELS: "gpt-5.4,gpt-5.6-sol",
      }),
    ).toBe("gpt-5.4");
  });

  test("allows only the curated OpenCode and Claude catalogs", () => {
    for (const model of Object.values(OPENCODE_ALLOWED_MODELS).flat()) {
      expect(isModelAllowedForEngine("opencode", model)).toBe(true);
    }
    expect(isModelAllowedForEngine("opencode", "openai/unbounded")).toBe(false);
    expect(isModelAllowedForEngine("opencode", KIMI_K3_MODEL)).toBe(true);
    expect(isModelAllowedForEngine("claude", "openai/gpt-5.6-sol")).toBe(false);
    expect(isModelAllowedForEngine("claude", KIMI_K3_MODEL)).toBe(false);
  });

  test("Codex allowlist is explicit and deployment-configurable", () => {
    expect(isModelAllowedForEngine("codex", "gpt-5.6-sol", {})).toBe(true);
    expect(isModelAllowedForEngine("codex", "gpt-5", {})).toBe(false);
    expect(isModelAllowedForEngine("codex", "gpt-unlisted", {})).toBe(false);
    expect(
      isModelAllowedForEngine("codex", "gpt-5.4", {
        CODEX_ALLOWED_MODELS: "gpt-5.6-sol,gpt-5.4",
      }),
    ).toBe(true);
  });

  test("generic ACP is never a paid execution target and mock stays test-friendly", () => {
    expect(isModelAllowedForEngine("acp", "anything")).toBe(false);
    expect(isModelAllowedForEngine("mock", "fixture-model")).toBe(true);
  });
});
