import { describe, expect, test } from "bun:test";
import {
  CODEX_ALLOWED_MODELS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENCODE_MODEL,
  DEEPSEEK_V4_FLASH_MODEL,
  GEMINI_FLASH_MODEL,
  FAST_CODEX_MODEL,
  FAST_OPENCODE_MODEL,
  KIMI_K3_MODEL,
  allowedModelsForEngine,
  defaultModelForEngine,
  isModelAllowedForEngine,
  OPENCODE_ALLOWED_MODELS,
} from "./model-policy";
import { FREE_MODEL_LANE_SEED } from "./free-model-lane";

describe("paid model policy", () => {
  test("uses engine-owned defaults", () => {
    expect(DEFAULT_OPENCODE_MODEL).toBe(FAST_OPENCODE_MODEL);
    expect(DEFAULT_CODEX_MODEL).toBe(FAST_CODEX_MODEL);
    expect(defaultModelForEngine("opencode", {})).toBe(FAST_OPENCODE_MODEL);
    expect(defaultModelForEngine("pi", {})).toBe(FAST_OPENCODE_MODEL);
    expect(defaultModelForEngine("claude", {})).toBe("claude-opus-5");
    expect(defaultModelForEngine("codex", {})).toBe(DEFAULT_CODEX_MODEL);
    expect(
      defaultModelForEngine("codex", {
        CODEX_ALLOWED_MODELS: "gpt-5.4,gpt-5.6-sol",
      }),
    ).toBe("gpt-5.4");
  });

  test("allows only the curated OpenCode and Claude catalogs", () => {
    expect(DEEPSEEK_V4_FLASH_MODEL).toBe("deepseek/deepseek-v4-flash");
    for (const model of Object.values(OPENCODE_ALLOWED_MODELS).flat()) {
      expect(isModelAllowedForEngine("opencode", model)).toBe(true);
    }
    expect(isModelAllowedForEngine("opencode", "openai/unbounded")).toBe(false);
    expect(isModelAllowedForEngine("opencode", "openai/gpt-5.6-sol-pro")).toBe(false);
    expect(isModelAllowedForEngine("opencode", KIMI_K3_MODEL)).toBe(true);
    expect(isModelAllowedForEngine("opencode", DEEPSEEK_V4_FLASH_MODEL)).toBe(true);
    expect(isModelAllowedForEngine("opencode", GEMINI_FLASH_MODEL)).toBe(true);
    expect(isModelAllowedForEngine("claude", "openai/gpt-5.6-sol")).toBe(false);
    expect(isModelAllowedForEngine("claude", KIMI_K3_MODEL)).toBe(false);
  });

  test("free OpenRouter slugs are an OpenCode-only lane", () => {
    // The dynamic lane serves its curated seed here (no catalog fetch in tests);
    // the fetched-lane behavior is covered in free-model-lane.test.ts.
    expect(FREE_MODEL_LANE_SEED.length).toBeGreaterThan(0);
    for (const model of FREE_MODEL_LANE_SEED) {
      expect(model.endsWith(":free")).toBe(true);
      expect(isModelAllowedForEngine("opencode", model)).toBe(true);
      expect(isModelAllowedForEngine("pi", model)).toBe(false);
      expect(isModelAllowedForEngine("daytona", model)).toBe(false);
      expect(isModelAllowedForEngine("claude", model)).toBe(false);
      expect(isModelAllowedForEngine("codex", model, {})).toBe(false);
      expect(isModelAllowedForEngine("chat", model, {})).toBe(false);
    }
    // Grouped after the paid catalog, and only in the OpenCode manifest.
    expect(allowedModelsForEngine("opencode", {})).toEqual([
      ...Object.values(OPENCODE_ALLOWED_MODELS).flat(),
      ...FREE_MODEL_LANE_SEED,
    ]);
    expect(allowedModelsForEngine("pi", {})).not.toContain(FREE_MODEL_LANE_SEED[0]);
    // The lane never changes the engine default.
    expect(defaultModelForEngine("opencode", {})).toBe(FAST_OPENCODE_MODEL);
  });

  test("Codex allowlist is explicit and deployment-configurable", () => {
    expect(isModelAllowedForEngine("codex", "gpt-5.6-sol", {})).toBe(true);
    expect(isModelAllowedForEngine("codex", "gpt-5.6-terra", {})).toBe(true);
    expect(isModelAllowedForEngine("codex", "gpt-5.6-luna", {})).toBe(true);
    expect(isModelAllowedForEngine("codex", "openai/gpt-5.6-sol", {})).toBe(false);
    expect(isModelAllowedForEngine("codex", "gpt-5", {})).toBe(false);
    expect(isModelAllowedForEngine("codex", "gpt-unlisted", {})).toBe(false);
    expect(
      isModelAllowedForEngine("codex", "gpt-5.4", {
        CODEX_ALLOWED_MODELS: "gpt-5.6-sol,gpt-5.4",
      }),
    ).toBe(true);
  });

  test("exposes engine-specific model catalogs using backend policy ids", () => {
    expect(CODEX_ALLOWED_MODELS).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
    ]);
    expect(allowedModelsForEngine("codex", {})).toEqual(CODEX_ALLOWED_MODELS);
    expect(
      allowedModelsForEngine("codex", {
        CODEX_ALLOWED_MODELS: "gpt-5.6-luna,gpt-5.4",
      }),
    ).toEqual(["gpt-5.6-luna", "gpt-5.4"]);
    expect(allowedModelsForEngine("chat", {})).toContain("anthropic/claude-sonnet-5");
    expect(isModelAllowedForEngine("chat", "anthropic/claude-sonnet-5", {})).toBe(true);
    expect(isModelAllowedForEngine("chat", "openai/unbounded", {})).toBe(false);
    expect(allowedModelsForEngine("opencode", {})).toEqual([
      ...Object.values(OPENCODE_ALLOWED_MODELS).flat(),
      ...FREE_MODEL_LANE_SEED,
    ]);
    expect(allowedModelsForEngine("pi", {})).toEqual(
      Object.values(OPENCODE_ALLOWED_MODELS).flat(),
    );
    expect(allowedModelsForEngine("acp", {})).toEqual([]);
  });

  test("generic ACP is never a paid execution target and mock stays test-friendly", () => {
    expect(isModelAllowedForEngine("acp", "anything")).toBe(false);
    expect(isModelAllowedForEngine("mock", "fixture-model")).toBe(true);
  });
});
