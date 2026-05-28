import { describe, expect, test } from "bun:test";
import {
  DEEPSEEK_V4_FLASH_MODEL,
  GEMINI_3_7_FLASH_MODEL,
  KIMI_K3_MODEL,
} from "../runs/model-policy";
import { applyOpenRouterProviderRouting } from "./provider-routing";

describe("OpenRouter provider routing", () => {
  test("routes Kimi K3 to the fastest endpoint that supports every requested agent parameter", () => {
    const routed = JSON.parse(
      applyOpenRouterProviderRouting(
        KIMI_K3_MODEL,
        JSON.stringify({
          model: KIMI_K3_MODEL,
          messages: [],
          tools: [{ type: "function", function: { name: "browser_navigate" } }],
          provider: { only: ["fireworks/fast"], allow_fallbacks: false },
        }),
      ),
    ) as Record<string, unknown>;

    expect(routed.provider).toEqual({
      sort: "throughput",
      require_parameters: true,
      allow_fallbacks: true,
    });
    expect(routed.tools).toEqual([
      { type: "function", function: { name: "browser_navigate" } },
    ]);
  });

  test("does not rewrite provider preferences for other OpenRouter models", () => {
    const body = JSON.stringify({
      model: "openai/gpt-5.6-sol",
      provider: { only: ["openai"] },
    });
    expect(applyOpenRouterProviderRouting("openai/gpt-5.6-sol", body)).toBe(body);
  });

  test("prefers Wafer Fast for DeepSeek V4 Flash agent turns", () => {
    const routed = JSON.parse(
      applyOpenRouterProviderRouting(
        DEEPSEEK_V4_FLASH_MODEL,
        JSON.stringify({
          model: DEEPSEEK_V4_FLASH_MODEL,
          messages: [],
          tools: [{ type: "function", function: { name: "bash" } }],
        }),
      ),
    ) as Record<string, unknown>;

    expect(routed.provider).toEqual({
      order: ["wafer/fast"],
      sort: "throughput",
      require_parameters: true,
      allow_fallbacks: true,
    });
  });

  test("selects the fastest compatible Gemini 3.7 Flash endpoint", () => {
    const routed = JSON.parse(
      applyOpenRouterProviderRouting(
        GEMINI_3_7_FLASH_MODEL,
        JSON.stringify({
          model: GEMINI_3_7_FLASH_MODEL,
          messages: [],
          tools: [{ type: "function", function: { name: "bash" } }],
        }),
      ),
    ) as Record<string, unknown>;

    expect(routed.provider).toEqual({
      sort: "throughput",
      require_parameters: true,
      allow_fallbacks: true,
    });
  });
});
