import { describe, expect, test } from "bun:test";
import { ENGINE_IDS } from "../db/schema";
import { resolveProviderRegistration } from "./index";
import { DEEPSEEK_HARNESS_COMPATIBILITY } from "./deepseek-harness-compat";

describe("DeepSeek Harness compatibility contract", () => {
  test("stays outside product registration until credentials and runtime are proven", () => {
    expect(ENGINE_IDS).not.toContain("deepseek-harness");
    expect(resolveProviderRegistration("deepseek-harness")).toBeUndefined();
    expect(DEEPSEEK_HARNESS_COMPATIBILITY).toMatchObject({
      package: "@deepseek-ai/dsh-acp-demo@0.1.1-rc.2",
      productRegistered: false,
      ready: false,
      capabilities: {
        streamingText: false,
        reasoning: false,
        plans: false,
        toolProgress: false,
        usage: false,
        commands: false,
        resume: false,
        load: false,
        stop: true,
        knowledgeTools: false,
      },
    });
  });
});
