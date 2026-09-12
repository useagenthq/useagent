import { describe, expect, test } from "bun:test";
import type { GatewayRun } from "./run-authorization";
import { applyProviderBodyPolicy } from "./request-policy";

const run: GatewayRun = {
  id: "run-a",
  orgId: "org-a",
  userId: "user-a",
  threadId: "thread-a",
  engine: "codex",
  model: "gpt-5",
  status: "running",
};

describe("provider request body policy", () => {
  test("requires the durable run model for every paid engine", () => {
    expect(applyProviderBodyPolicy(run, '{"model":"gpt-other"}', "max_output_tokens", 100)).toEqual({
      ok: false,
      error: "model_not_allowed",
    });
  });

  test("accepts only the exact bare OpenAI model for a qualified OpenCode run", () => {
    const openCodeRun = {
      ...run,
      engine: "opencode",
      model: "openai/gpt-5.6-luna",
    } satisfies GatewayRun;

    expect(
      applyProviderBodyPolicy(
        openCodeRun,
        '{"model":"gpt-5.6-luna"}',
        "max_output_tokens",
        100,
      ).ok,
    ).toBe(true);
    expect(
      applyProviderBodyPolicy(
        openCodeRun,
        '{"model":"gpt-5.6-sol"}',
        "max_output_tokens",
        100,
      ),
    ).toEqual({ ok: false, error: "model_not_allowed" });
  });

  test("accepts the exact bare OpenAI model emitted by Pi", () => {
    const piRun = {
      ...run,
      engine: "pi",
      model: "openai/gpt-5.6-luna",
    } satisfies GatewayRun;
    expect(applyProviderBodyPolicy(
      piRun,
      '{"model":"gpt-5.6-luna"}',
      "max_output_tokens",
      100,
    ).ok).toBe(true);
    expect(applyProviderBodyPolicy(
      piRun,
      '{"model":"gpt-5.6-sol"}',
      "max_output_tokens",
      100,
    )).toEqual({ ok: false, error: "model_not_allowed" });
  });

  test("accepts the exact current or legacy bare model id for a Cerebras run", () => {
    for (const model of ["qwen-3.8-27b", "gemma-4-31b"]) {
      const cerebrasRun = {
        ...run,
        engine: "opencode",
        model: `cerebras/${model}`,
      } satisfies GatewayRun;
      expect(applyProviderBodyPolicy(
        cerebrasRun,
        JSON.stringify({ model }),
        "max_tokens",
        100,
      ).ok).toBe(true);
    }
    const currentRun = {
      ...run,
      engine: "opencode",
      model: "cerebras/qwen-3.8-27b",
    } satisfies GatewayRun;
    expect(applyProviderBodyPolicy(
      currentRun,
      '{"model":"gpt-oss-120b"}',
      "max_tokens",
      100,
    )).toEqual({ ok: false, error: "model_not_allowed" });
  });

  test("adds a missing output ceiling and preserves a smaller one", () => {
    const added = applyProviderBodyPolicy(run, '{"model":"gpt-5"}', "max_output_tokens", 100);
    expect(added.ok && JSON.parse(added.body).max_output_tokens).toBe(100);
    expect(added.ok && added.requestedOutputTokens).toBe(100);
    const kept = applyProviderBodyPolicy(
      run,
      '{"model":"gpt-5","max_output_tokens":25}',
      "max_output_tokens",
      100,
    );
    expect(kept.ok && JSON.parse(kept.body).max_output_tokens).toBe(25);
    expect(kept.ok && kept.requestedOutputTokens).toBe(25);
  });

  test("rejects invalid and excessive output budgets", () => {
    for (const value of [0, -1, 100.5, 101, "100"]) {
      const result = applyProviderBodyPolicy(
        run,
        JSON.stringify({ model: "gpt-5", max_output_tokens: value }),
        "max_output_tokens",
        100,
      );
      expect(result).toEqual({ ok: false, error: "output_limit_exceeded" });
    }
  });
});
