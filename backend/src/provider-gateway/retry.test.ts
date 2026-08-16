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

  test("marks retryable responses non-retryable after the gateway budget is exhausted", async () => {
    let calls = 0;
    const response = await fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
      body: "stable-body",
    }, {
      fetch: async () => {
        calls += 1;
        return new Response(`limited-${calls}`, {
          status: 429,
          headers: { "retry-after": "7" },
        });
      },
      maxRetries: 1,
      sleep: async () => undefined,
    });

    expect(calls).toBe(2);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.text()).toBe("limited-2");
  });

  test("does not classify a 429 body after the retry budget is exhausted", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const pendingResponse = fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
    }, {
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(new TextEncoder().encode("rate_limit_error"));
        },
      }), { status: 429 }),
      maxRetries: 0,
    });
    const timeout = Symbol("timeout");
    const deadline = Promise.withResolvers<typeof timeout>();
    const timer = setTimeout(() => deadline.resolve(timeout), 50);
    const result = await Promise.race([pendingResponse, deadline.promise]);
    clearTimeout(timer);

    if (result === timeout) {
      streamController?.close();
      await pendingResponse;
      throw new Error("exhausted retry response waited for body classification");
    }

    expect(result.headers.get("x-should-retry")).toBe("false");
    await result.body?.cancel();
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

  test("returns a bounded terminal prefix without waiting for an endless body", async () => {
    const sourceResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `insufficient_quota${" ".repeat(64 * 1024)}`,
        ));
      },
    }), { status: 429 });
    const pendingResponse = fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
    }, {
      fetch: async () => sourceResponse,
      maxRetries: 0,
    });
    const timeout = Symbol("timeout");
    const deadline = Promise.withResolvers<typeof timeout>();
    const timer = setTimeout(() => deadline.resolve(timeout), 250);
    const result = await Promise.race([pendingResponse, deadline.promise]);
    clearTimeout(timer);

    if (result === timeout) {
      await sourceResponse.body?.cancel();
      try {
        await pendingResponse;
      } catch {
        // The assertion below is the regression signal; cleanup must still settle.
      }
      throw new Error("bounded response classification timed out");
    }

    expect(result.headers.get("x-should-retry")).toBe("false");
    const reader = result.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader?.read();
    expect(firstChunk?.done).toBe(false);
    expect(new TextDecoder().decode(firstChunk?.value)).toContain("insufficient_quota");
    await reader?.cancel();
  });

  test("bounds classification when a small first chunk never closes", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const sourceResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode("rate_limit_error"));
      },
    }), { status: 429 });
    const pendingResponse = fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
    }, {
      fetch: async () => sourceResponse,
      maxRetries: 0,
    });
    const timeout = Symbol("timeout");
    const deadline = Promise.withResolvers<typeof timeout>();
    const timer = setTimeout(() => deadline.resolve(timeout), 500);
    const result = await Promise.race([pendingResponse, deadline.promise]);
    clearTimeout(timer);

    if (result === timeout) {
      streamController?.close();
      await pendingResponse;
      throw new Error("small-prefix response classification timed out");
    }

    expect(result.headers.get("x-should-retry")).toBe("false");
    streamController?.close();
    expect(await result.text()).toBe("rate_limit_error");
  });

  test("detects a terminal quota marker split across normal chunks", async () => {
    let calls = 0;
    const response = await fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
    }, {
      fetch: async () => {
        calls += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("insuffici"));
            controller.enqueue(new TextEncoder().encode("ent_quota"));
            controller.close();
          },
        }), { status: 429 });
      },
      maxRetries: 1,
      sleep: async () => {
        throw new Error("split terminal quota failures must not sleep");
      },
    });

    expect(calls).toBe(1);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.text()).toBe("insufficient_quota");
  });

  test("absorbs a rejected clone cancellation after bounded classification", async () => {
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", recordUnhandledRejection);

    try {
      let cancellationCalls = 0;
      const sourceResponse = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `insufficient_quota${" ".repeat(64 * 1024)}`,
          ));
        },
        cancel() {
          cancellationCalls += 1;
          return Promise.reject(new Error("source cancellation failed"));
        },
      }), { status: 429 });
      const result = await fetchProviderUpstream("https://api.openai.test/v1/responses", {
        method: "POST",
      }, {
        fetch: async () => sourceResponse,
        maxRetries: 0,
      });
      const reader = result.body?.getReader();
      expect(reader).toBeDefined();
      await reader?.read();

      let cancellationError: unknown;
      try {
        await reader?.cancel();
      } catch (error) {
        cancellationError = error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(cancellationError).toEqual(new Error("source cancellation failed"));
      expect(cancellationCalls).toBe(1);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandledRejection);
    }
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

  test("honors an explicit provider retry directive while gateway budget remains", async () => {
    let calls = 0;
    const delays: number[] = [];
    const response = await fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
    }, {
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("refreshable", {
            status: 401,
            headers: { "retry-after": "2", "x-should-retry": "true" },
          })
          : new Response("ok", { status: 200 });
      },
      maxRetries: 1,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(calls).toBe(2);
    expect(delays).toEqual([2_000]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("overrides an explicit provider retry directive when gateway budget is exhausted", async () => {
    let calls = 0;
    const response = await fetchProviderUpstream("https://api.openai.test/v1/responses", {
      method: "POST",
    }, {
      fetch: async () => {
        calls += 1;
        return new Response(`refreshable-${calls}`, {
          status: 401,
          headers: { "retry-after": "2", "x-should-retry": "true" },
        });
      },
      maxRetries: 1,
      sleep: async () => undefined,
    });

    expect(calls).toBe(2);
    expect(response.status).toBe(401);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.text()).toBe("refreshable-2");
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
