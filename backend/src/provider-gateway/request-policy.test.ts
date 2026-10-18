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

  test("accepts Zen's own id or our lane id for an OpenCode Zen run, nothing else", () => {
    const zenRun = { ...run, engine: "opencode", model: "opencode/big-pickle:free" } satisfies GatewayRun;
    for (const model of ["big-pickle", "opencode/big-pickle:free"]) {
      expect(applyProviderBodyPolicy(zenRun, JSON.stringify({ model }), "max_tokens", 100).ok).toBe(true);
    }
    expect(applyProviderBodyPolicy(zenRun, '{"model":"big-pickle:free"}', "max_tokens", 100))
      .toEqual({ ok: false, error: "model_not_allowed" });
    expect(applyProviderBodyPolicy(zenRun, '{"model":"opencode/claude-opus-5"}', "max_tokens", 100))
      .toEqual({ ok: false, error: "model_not_allowed" });
  });

  test("refuses a fallback model list or a routing mode beside the run's model", () => {
    const freeRun = { ...run, engine: "opencode", model: "vendor/model:free" } satisfies GatewayRun;
    expect(applyProviderBodyPolicy(
      freeRun,
      JSON.stringify({ model: "vendor/model:free", models: ["openai/gpt-4o"], max_tokens: 16 }),
      "max_tokens",
      100,
    )).toEqual({ ok: false, error: "model_not_allowed" });
    expect(applyProviderBodyPolicy(
      freeRun,
      JSON.stringify({ model: "vendor/model:free", route: "fallback", max_tokens: 16 }),
      "max_tokens",
      100,
    )).toEqual({ ok: false, error: "model_not_allowed" });
    expect(applyProviderBodyPolicy(
      freeRun,
      JSON.stringify({ model: "vendor/model:free", max_tokens: 16 }),
      "max_tokens",
      100,
    ).ok).toBe(true);
  });

  test("an OpenRouter request carries only the chat-completion fields; paid extras are refused", () => {
    const freeRun = { ...run, engine: "opencode", model: "vendor/model:free" } satisfies GatewayRun;
    const plain = {
      model: "vendor/model:free",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      usage: { include: true },
      provider: { sort: "throughput" },
      transforms: ["middle-out"],
    };
    expect(applyProviderBodyPolicy(freeRun, JSON.stringify(plain), "max_tokens", 100, "openrouter").ok).toBe(true);
    // Parts a model reads itself pass; a file part would buy a paid document parser.
    expect(applyProviderBodyPolicy(freeRun, JSON.stringify({
      ...plain,
      reasoning_effort: "low",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }],
    }), "max_tokens", 100, "openrouter").ok).toBe(true);
    for (const extra of [
      { plugins: [{ id: "web", engine: "exa" }] },
      { tools: [{ type: "openrouter:advisor", parameters: { model: "openai/gpt-4o" } }], tool_choice: "required" },
      { web_search_options: { search_context_size: "high" } },
      { tools: "not-a-list" },
      { messages: [{ role: "user", content: [{ type: "file", file: { filename: "d.pdf", file_data: "https://example.com/d.pdf" } }] }] },
      { messages: "not-a-list" },
    ]) {
      expect(applyProviderBodyPolicy(freeRun, JSON.stringify({ ...plain, ...extra }), "max_tokens", 100, "openrouter"))
        .toEqual({ ok: false, error: "request_not_allowed" });
    }
    // Other providers keep their own request shapes.
    const openaiRun = { ...run, engine: "opencode", model: "openai/gpt-5.6-luna" } satisfies GatewayRun;
    expect(applyProviderBodyPolicy(openaiRun, JSON.stringify({ model: "gpt-5.6-luna", input: "hi", store: false }), "max_output_tokens", 100, "openai").ok).toBe(true);
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
      expect(result).toEqual({ ok: false, error: "output_limit_exceeded", requested: value });
    }
  });
});
