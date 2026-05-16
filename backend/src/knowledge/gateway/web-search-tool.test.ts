import { describe, expect, test } from "bun:test";
import type { GatewayRun } from "../../provider-gateway/run-authorization";
import {
  executeWebSearchTool,
  parseOpenAIWebSearchResponse,
  parseOpenRouterWebSearchResponse,
} from "./web-search-tool";
import type { ToolTokenClaims } from "./token";

const claims: ToolTokenClaims = {
  orgId: "org-1",
  userId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  scope: "run",
  exp: Date.now() + 60_000,
};

const run: GatewayRun = {
  id: "run-1",
  orgId: "org-1",
  userId: "user-1",
  threadId: "thread-1",
  engine: "codex",
  model: "gpt-5.6-luna",
  status: "running",
};

const openAIResponse = {
  output: [
    { type: "web_search_call", id: "search-1", status: "completed" },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "C3.ai traded at a recent quoted price.",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.test/quote",
              title: "C3.ai quote",
            },
          ],
        },
      ],
    },
  ],
};

const openRouterResponse = {
  choices: [{
    message: {
      content: "The official Codex documentation is available from OpenAI.",
      annotations: [{
        type: "url_citation",
        url_citation: {
          url: "https://developers.openai.com/codex/",
          title: "Codex documentation",
          content: "Official documentation",
          start_index: 0,
          end_index: 10,
        },
      }],
    },
  }],
};

describe("web search gateway", () => {
  test("parses Responses API search calls, text, and URL citations", () => {
    expect(parseOpenAIWebSearchResponse(openAIResponse)).toEqual({
      searched: true,
      sources: [{ title: "C3.ai quote", url: "https://example.test/quote" }],
      errors: [],
      text: "C3.ai traded at a recent quoted price.",
    });
  });

  test("routes Codex search through the audited provider gateway", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const result = await executeWebSearchTool(claims, "web_search", { query: "C3.ai price" }, {
      findRun: async () => run,
      providerConfig: () => ({ publicUrl: "https://gateway.example.test", tokenTtlMs: 60_000 }),
      mintToken: () => "provider-capability",
      fetchGateway: async (input, init) => {
        request = { url: String(input), init };
        return Response.json(openAIResponse);
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("https://example.test/quote");
    expect(request?.url).toBe("https://gateway.example.test/api/provider/openai/v1/responses");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe(
      "Bearer provider-capability",
    );
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({
      model: "gpt-5.6-luna",
      tools: [{ type: "web_search" }],
      input: expect.stringContaining("C3.ai price"),
    });
  });

  test("parses OpenRouter web-plugin citations", () => {
    expect(parseOpenRouterWebSearchResponse(openRouterResponse)).toEqual({
      searched: true,
      sources: [{
        title: "Codex documentation",
        url: "https://developers.openai.com/codex/",
      }],
      errors: [],
      text: "The official Codex documentation is available from OpenAI.",
    });
  });

  test("routes OpenCode search through OpenRouter's web plugin", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const result = await executeWebSearchTool(
      { ...claims, runId: "run-openrouter" },
      "web_search",
      { query: "official Codex docs", max_searches: 3 },
      {
        findRun: async () => ({
          ...run,
          id: "run-openrouter",
          engine: "opencode",
          model: "moonshotai/kimi-k2.5",
        }),
        providerConfig: () => ({
          publicUrl: "https://gateway.example.test",
          tokenTtlMs: 60_000,
        }),
        mintToken: () => "provider-capability",
        fetchGateway: async (input, init) => {
          request = { url: String(input), init };
          return Response.json(openRouterResponse);
        },
      },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("https://developers.openai.com/codex/");
    expect(request?.url).toBe(
      "https://gateway.example.test/api/provider/openrouter/v1/chat/completions",
    );
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({
      model: "moonshotai/kimi-k2.5",
      plugins: [{ id: "web", max_results: 3 }],
      messages: [{ role: "user", content: expect.stringContaining("official Codex docs") }],
    });
  });

  test("does not fall back to a host provider key when gateway wiring is absent", async () => {
    const result = await executeWebSearchTool(claims, "web_search", { query: "latest quote" }, {
      findRun: async () => run,
      providerConfig: () => null,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("provider gateway is not configured");
  });
});
