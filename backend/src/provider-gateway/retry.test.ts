import { describe, expect, test } from "bun:test";
import {
  fetchProviderUpstream,
  providerGatewayMaxRetries,
  providerRetryDelayMs,
  shouldRetryProviderResponse,
} from "./retry";

describe("provider gateway upstream retries", () => {
  test("uses the official SDK retry status class and honors opt-out", () => {
    for (const status of [408, 409, 429, 500, 503]) {
      expect(shouldRetryProviderResponse(new Response(null, { status }))).toBe(true);
    }
    expect(shouldRetryProviderResponse(new Response(null, { status: 400 }))).toBe(false);
    expect(shouldRetryProviderResponse(new Response(null, {
      status: 503,
      headers: { "x-should-retry": "false" },
    }))).toBe(false);
  });

  test("uses bounded configuration and Retry-After guidance", () => {
    expect(providerGatewayMaxRetries({})).toBe(2);
    expect(providerGatewayMaxRetries({ PROVIDER_GATEWAY_MAX_RETRIES: "5" })).toBe(5);
    expect(providerGatewayMaxRetries({ PROVIDER_GATEWAY_MAX_RETRIES: "999" })).toBe(10);
    expect(providerRetryDelayMs(0, new Headers({ "retry-after-ms": "1250" }), () => 0)).toBe(1250);
    expect(providerRetryDelayMs(1, null, () => 0)).toBe(1000);
  });

  test("absorbs connection failures before the caller can replay a tool", async () => {
    const calls: number[] = [];
    const retries: Array<{ attempt: number; status: number | null }> = [];
    const response = await fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
      body: "{}",
    }, {
      fetch: async () => {
        calls.push(calls.length + 1);
        if (calls.length === 1) throw new Error("connection closed");
        return new Response("ok", { status: 200 });
      },
      maxRetries: 2,
      random: () => 0,
      sleep: async () => undefined,
      onRetry: ({ attempt, status }) => retries.push({ attempt, status }),
    });

    expect(await response.text()).toBe("ok");
    expect(calls).toEqual([1, 2]);
    expect(retries).toEqual([{ attempt: 1, status: null }]);
  });

  test("retries 429 with one stable request body and then returns success", async () => {
    const bodies: string[] = [];
    const delays: number[] = [];
    const response = await fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
      body: "stable-body",
    }, {
      fetch: async (_input, init) => {
        bodies.push(String(init?.body));
        return bodies.length === 1
          ? new Response("limited", { status: 429, headers: { "retry-after-ms": "25" } })
          : new Response("ok", { status: 200 });
      },
      maxRetries: 2,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(await response.text()).toBe("ok");
    expect(bodies).toEqual(["stable-body", "stable-body"]);
    expect(delays).toEqual([25]);
  });

  test("does not retry a terminal quota response and tells the downstream SDK to stop", async () => {
    let calls = 0;
    const response = await fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
      body: "stable-body",
    }, {
      fetch: async () => {
        calls += 1;
        return Response.json({
          error: {
            type: "insufficient_quota",
            code: "insufficient_quota",
            message: "You have no credits remaining. Add credits to continue using the API.",
          },
        }, { status: 429 });
      },
      maxRetries: 10,
      sleep: async () => {
        throw new Error("terminal quota failures must not sleep");
      },
    });

    expect(calls).toBe(1);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    const payload = await response.json() as { error: { code: string } };
    expect(payload.error.code).toBe("insufficient_quota");
  });

  test("keeps ordinary rate limits retryable when their body is not a terminal quota error", async () => {
    let calls = 0;
    const response = await fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
      body: "stable-body",
    }, {
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? Response.json({ error: { type: "rate_limit_error", message: "Too many requests" } }, {
            status: 429,
          })
          : new Response("ok", { status: 200 });
      },
      maxRetries: 2,
      sleep: async () => undefined,
    });

    expect(calls).toBe(2);
    expect(await response.text()).toBe("ok");
  });

  test("marks terminal provider auth and billing failures as non-retryable", async () => {
    for (const status of [401, 402, 403]) {
      const response = await fetchProviderUpstream("https://api.openai.test/v1/responses", {
        method: "POST",
        body: "stable-body",
      }, {
        fetch: async () => new Response(`terminal-${status}`, { status }),
        maxRetries: 10,
        sleep: async () => {
          throw new Error("terminal provider failures must not sleep");
        },
      });

      expect(response.status).toBe(status);
      expect(response.headers.get("x-should-retry")).toBe("false");
      expect(await response.text()).toBe(`terminal-${status}`);
    }
  });

  test("preserves an explicit provider retry directive on terminal statuses", async () => {
    const response = await fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
    }, {
      fetch: async () => new Response("refreshable", {
        status: 401,
        headers: { "x-should-retry": "true" },
      }),
      maxRetries: 0,
    });

    expect(response.headers.get("x-should-retry")).toBe("true");
  });

  test("rejects oversized provider backoff instead of making the downstream SDK sleep for minutes", async () => {
    let calls = 0;
    const response = await fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
      body: "stable-body",
    }, {
      fetch: async () => {
        calls += 1;
        return new Response("try much later", {
          status: 429,
          headers: { "retry-after": "120" },
        });
      },
      maxRetries: 10,
      sleep: async () => {
        throw new Error("oversized provider backoff must not sleep locally");
      },
    });

    expect(calls).toBe(1);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.text()).toBe("try much later");
  });
});
