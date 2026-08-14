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
});
