import { describe, expect, test } from "bun:test";
import {
  activateOpenCodeRuntimeConfig,
  verifyOpenCodeRuntimeConfig,
  type OpenCodeRuntimeServer,
} from "./opencode-runtime-config";

const server: OpenCodeRuntimeServer = {
  baseUrl: "https://sandbox.example.test",
  token: "preview-token",
  workdir: "/root/work",
};

const config = {
  provider: {
    anthropic: {
      options: {
        baseURL: "https://gateway.example.test/provider/anthropic/v1",
        apiKey: "run-anthropic-token",
      },
    },
    openrouter: {
      options: {
        baseURL: "https://gateway.example.test/provider/openrouter/v1",
        apiKey: "run-openrouter-token",
      },
    },
  },
  mcp: {
    "skynet-knowledge": {
      type: "remote",
      url: "https://gateway.example.test/mcp",
      enabled: true,
      headers: { Authorization: "Bearer run-tool-token" },
    },
    "skynet-browser": {
      type: "local",
      command: ["/root/.local/bin/playwright-mcp", "--cdp-endpoint", "http://127.0.0.1:9222"],
      enabled: true,
    },
  },
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("OpenCode resident runtime config", () => {
  test("activates exact managed capabilities without restarting the process", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      });
      if (url.endsWith("/global/config")) return json(config);
      if (url.includes("/config?")) return json(config);
      if (url.includes("/provider?")) return json([]);
      if (url.includes("/mcp?")) {
        return json({
          "skynet-knowledge": { status: "connected" },
          "skynet-browser": { status: "connected" },
        });
      }
      if (url.includes("/session/ses_warm?")) return json({ id: "ses_warm" });
      throw new Error(`unexpected request ${method} ${url}`);
    };

    await activateOpenCodeRuntimeConfig({
      server,
      config,
      sessionId: "ses_warm",
      signal: new AbortController().signal,
      fetcher,
      timeoutMs: 100,
    });

    expect(calls[0]).toEqual({
      url: "https://sandbox.example.test/global/config",
      method: "PATCH",
      body: config,
    });
    expect(calls.map(({ url }) => url)).toEqual(expect.arrayContaining([
      "https://sandbox.example.test/config?directory=%2Froot%2Fwork",
      "https://sandbox.example.test/provider?directory=%2Froot%2Fwork",
      "https://sandbox.example.test/mcp?directory=%2Froot%2Fwork",
      "https://sandbox.example.test/session/ses_warm?directory=%2Froot%2Fwork",
    ]));
  });

  test("rejects a stale effective provider token before prompt dispatch", async () => {
    const stale = structuredClone(config);
    stale.provider.anthropic.options.apiKey = "previous-run-token";
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/config?")) return json(stale);
      if (url.includes("/provider?")) return json([]);
      if (url.includes("/mcp?")) {
        return json({
          "skynet-knowledge": { status: "connected" },
          "skynet-browser": { status: "connected" },
        });
      }
      throw new Error(`unexpected request ${url}`);
    };

    await expect(
      verifyOpenCodeRuntimeConfig({
        server,
        config,
        signal: new AbortController().signal,
        fetcher,
        timeoutMs: 0,
      }),
    ).rejects.toThrow("OpenCode runtime config did not become active");
  });

  test("rejects an MCP capability that has not reconnected", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/config?")) return json(config);
      if (url.includes("/provider?")) return json([]);
      if (url.includes("/mcp?")) {
        return json({
          "skynet-knowledge": { status: "failed", error: "not ready" },
          "skynet-browser": { status: "connected" },
        });
      }
      throw new Error(`unexpected request ${url}`);
    };

    await expect(
      verifyOpenCodeRuntimeConfig({
        server,
        config,
        signal: new AbortController().signal,
        fetcher,
        timeoutMs: 0,
      }),
    ).rejects.toThrow("OpenCode runtime config did not become active");
  });

  test("rejects a non-successful global config update", async () => {
    const fetcher = async () => new Response(null, { status: 500 });

    await expect(
      activateOpenCodeRuntimeConfig({
        server,
        config,
        signal: new AbortController().signal,
        fetcher,
        timeoutMs: 0,
      }),
    ).rejects.toThrow("OpenCode global config update failed (HTTP 500)");
  });
});
