import { describe, expect, test } from "bun:test";
import { resolveEnabledEngine } from "@/components/chat/engine-picker";
import {
  CHAT_MODELS,
  CODEX_MODELS,
  MODELS,
  modelLabel,
  modelOptionsForEngine,
  selectableModelsForEngine,
  supportsPreSessionModelSelection,
} from "@/components/chat/types";

describe("engine model catalog", () => {
  test("reconciles a stale selection to the first engine the server actually enables", () => {
    expect(resolveEnabledEngine("opencode", ["chat"])).toBe("chat");
    expect(resolveEnabledEngine("chat", ["chat", "opencode"])).toBe("chat");
    expect(resolveEnabledEngine("opencode", [])).toBeNull();
  });

  test("Codex picker uses backend-policy model ids, not OpenRouter ids", () => {
    expect(CODEX_MODELS.map((m) => m.value)).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
    ]);
    expect(selectableModelsForEngine("codex").map((m) => m.value)).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
    ]);
    expect(selectableModelsForEngine("codex").some((m) => m.value.startsWith("openai/"))).toBe(
      false,
    );
  });

  test("OpenCode picker keeps provider-qualified model ids", () => {
    expect(selectableModelsForEngine("opencode")).toEqual(MODELS);
    expect(selectableModelsForEngine("opencode")[0]?.value).toBe("openai/gpt-5.6-luna");
    expect(selectableModelsForEngine("opencode").map((m) => m.value)).toContain(
      "openai/gpt-5.6-luna",
    );
    expect(selectableModelsForEngine("opencode").map((m) => m.value)).not.toContain(
      "openai/gpt-5.6-sol-pro",
    );
    expect(selectableModelsForEngine("opencode").map((m) => m.value)).toContain(
      "deepseek/deepseek-v4-flash",
    );
    expect(
      selectableModelsForEngine("opencode").find(
        (model) => model.value === "deepseek/deepseek-v4-flash",
      )?.label,
    ).toBe("DeepSeek V4 Flash · Wafer Fast");
    expect(selectableModelsForEngine("opencode").map((m) => m.value)).toContain(
      "google/gemini-3.7-flash",
    );
  });

  test("direct Chat picker exposes only the backend OpenRouter catalog", () => {
    expect(selectableModelsForEngine("chat")).toEqual(CHAT_MODELS);
    expect(CHAT_MODELS.map((model) => model.value)).toEqual([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-haiku-4.5",
      "z-ai/glm-5.2",
    ]);
    expect(supportsPreSessionModelSelection("chat")).toBe(true);
  });

  test("non-selectable engines expose no model choices", () => {
    expect(selectableModelsForEngine("claude")).toEqual([]);
    expect(selectableModelsForEngine("acp")).toEqual([]);
  });

  test("keeps model selection available while supported sessions are booting", () => {
    expect(supportsPreSessionModelSelection("codex")).toBe(true);
    expect(supportsPreSessionModelSelection("opencode")).toBe(true);
    expect(supportsPreSessionModelSelection("claude")).toBe(false);
  });

  test("labels resolve against the engine-specific catalog", () => {
    expect(modelLabel("gpt-5.6-terra", "codex")).toBe("GPT-5.6 Terra");
    expect(modelLabel("openai/gpt-5.6-terra", "opencode")).toBe("GPT-5.6 Terra");
    expect(modelLabel("gpt-5.6-terra", "opencode")).toBe("gpt-5.6-terra");
  });

  test("backend-configured catalogs filter and preserve exact submitted ids", () => {
    expect(modelOptionsForEngine("codex", ["gpt-5.6-luna", "gpt-5.4"])).toEqual([
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna · Fast", tint: "text-sky-500" },
      { value: "gpt-5.4", label: "gpt-5.4", tint: "text-text-secondary" },
    ]);
    expect(modelOptionsForEngine("opencode", ["openai/gpt-5.6-sol"])[0]?.value).toBe(
      "openai/gpt-5.6-sol",
    );
    expect(modelOptionsForEngine("claude", ["claude-opus-5"])).toEqual([]);
  });
});
