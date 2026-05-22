import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ProviderGatewayAdmissionError } from "./audit";
import type { GatewayRun } from "./run-authorization";
import {
  createProviderGatewayRoutes,
  providerUpstreamOrigin,
  type ProviderRouteDeps,
} from "./routes";
import type { ProviderTokenClaims } from "./token";
import { KIMI_K3_MODEL } from "../runs/model-policy";

const claims: ProviderTokenClaims = {
  orgId: "org-a",
  userId: "user-a",
  threadId: "thread-a",
  issuedRunId: "run-a",
  engine: "opencode",
  provider: "openrouter",
  scope: "run",
  exp: Date.now() + 60_000,
};

const run: GatewayRun = {
  id: "run-a",
  orgId: "org-a",
  userId: "user-a",
  threadId: "thread-a",
  engine: "opencode",
  model: "anthropic/claude-sonnet-4",
  status: "running",
};

function app(options: {
  token?: ProviderTokenClaims | null;
  activeRun?: GatewayRun | null;
  activeThreadRun?: GatewayRun | null;
  credential?: string | null;
  resolveCredential?: ProviderRouteDeps["resolveCredential"];
  fetchUpstream?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  beginAudit?: () => Promise<void>;
  finishAudit?: () => Promise<void>;
} = {}): Hono {
  const app = new Hono();
  app.route(
    "/api/provider",
    createProviderGatewayRoutes({
      verifyToken: () => options.token === undefined ? claims : options.token,
      findRunningRun: async () => options.activeRun === undefined ? run : options.activeRun,
      findActiveThreadRun: async () =>
        options.activeThreadRun === undefined ? null : options.activeThreadRun,
      resolveCredential: options.resolveCredential ??
        (async () => {
          if (options.credential === null) return null;
          return { value: options.credential ?? "real-upstream-key", source: "backend_env" };
        }),
      fetchUpstream: options.fetchUpstream,
      beginAudit: options.beginAudit ?? (async () => undefined),
      finishAudit: options.finishAudit ?? (async () => undefined),
    }),
  );
  return app;
}

describe("provider gateway routes", () => {
  test("upstream overrides reject insecure or unallowlisted production origins", () => {
    expect(() =>
      providerUpstreamOrigin("openai", {
        SKYNET_DEV_MODE: "false",
        OPENAI_UPSTREAM_BASE_URL: "http://169.254.169.254",
      }),
    ).toThrow("requires HTTPS");
    expect(() =>
      providerUpstreamOrigin("openai", {
        SKYNET_DEV_MODE: "false",
        OPENAI_UPSTREAM_BASE_URL: "https://proxy.example.test",
      }),
    ).toThrow("not in PROVIDER_GATEWAY_UPSTREAM_HOSTS");
    expect(
      providerUpstreamOrigin("openai", {
        SKYNET_DEV_MODE: "false",
        OPENAI_UPSTREAM_BASE_URL: "https://proxy.example.test",
        PROVIDER_GATEWAY_UPSTREAM_HOSTS: "proxy.example.test",
      }),
    ).toBe("https://proxy.example.test");
  });

  test("rejects missing/invalid capability before resolving provider traffic", async () => {
    const response = await app({ token: null }).request("/api/provider/openrouter/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: run.model }),
    });
    expect(response.status).toBe(401);
  });

  test("rejects a capability when there is no matching running turn", async () => {
    const response = await app({ activeRun: null }).request("/api/provider/openrouter/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: run.model }),
    });
    expect(response.status).toBe(403);
  });

  test("OpenCode cannot spend the capability on a model other than the active run", async () => {
    const response = await app().request("/api/provider/openrouter/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "openai/not-authorized" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "model_not_allowed" });
  });

  test("a capability cannot authorize another running turn in the same thread", async () => {
    const response = await app({ activeRun: { ...run, id: "run-new" } }).request(
      "/api/provider/openrouter/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({ model: run.model }),
      },
    );
    expect(response.status).toBe(403);
  });

  test("Claude and Codex cannot change the durable run model", async () => {
    const claudeClaims = { ...claims, engine: "claude" as const, provider: "anthropic" as const };
    const claudeRun = {
      ...run,
      engine: "claude" as const,
      model: "claude-opus-5",
    };
    const claude = await app({ token: claudeClaims, activeRun: claudeRun }).request(
      "/api/provider/anthropic/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10 }),
      },
    );
    expect(claude.status).toBe(403);

    const codexClaims = { ...claims, engine: "codex" as const, provider: "openai" as const };
    const codexRun = { ...run, engine: "codex" as const, model: "gpt-5" };
    const codex = await app({ token: codexClaims, activeRun: codexRun }).request(
      "/api/provider/openai/v1/responses",
      {
        method: "POST",
        body: JSON.stringify({ model: "gpt-other", max_output_tokens: 10 }),
      },
    );
    expect(codex.status).toBe(403);
  });

  test("replaces sandbox auth with the server-side key and preserves an SSE body", async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    let auditCompletions = 0;
    const fetchUpstream = async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(input), init };
      return new Response("data: ok\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream", "set-cookie": "never-forward=1" },
      });
    };
    const response = await app({
      fetchUpstream,
      finishAudit: async () => {
        auditCompletions++;
      },
    }).request(
      "/api/provider/openrouter/v1/chat/completions?trace=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer sandbox-capability",
          cookie: "session=must-not-forward",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: run.model, stream: true }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: ok\n\n");
    const forwarded = captured as { url: string; init?: RequestInit } | null;
    expect(forwarded?.url).toBe("https://openrouter.ai/api/v1/chat/completions?trace=1");
    const headers = new Headers(forwarded?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer real-upstream-key");
    expect(headers.get("cookie")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(JSON.parse(String(forwarded?.init?.body))).toMatchObject({
      model: run.model,
      max_tokens: 65_536,
      stream: true,
    });
    expect(auditCompletions).toBe(1);
  });

  test("resolves upstream credentials with the active run user", async () => {
    type ResolveInput = Parameters<NonNullable<ProviderRouteDeps["resolveCredential"]>>[0];
    const captured = {
      credentialInput: null as ResolveInput | null,
      authorization: null as string | null,
    };

    const response = await app({
      resolveCredential: async (input) => {
        captured.credentialInput = input;
        return { value: "user-owned-key", source: "user_connection" };
      },
      fetchUpstream: async (_input, init) => {
        captured.authorization = new Headers(init?.headers).get("authorization");
        return Response.json({ ok: true });
      },
    }).request("/api/provider/openrouter/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sandbox-capability" },
      body: JSON.stringify({ model: run.model }),
    });

    expect(response.status).toBe(200);
    expect(captured.credentialInput).toEqual({
      orgId: claims.orgId,
      userId: claims.userId,
      provider: "openrouter",
    });
    expect(captured.authorization).toBe("Bearer user-owned-key");
  });

  test("an invalid customer key surfaces the provider error, never falls back to the house key", async () => {
    const attempts: string[] = [];
    const response = await app({
      // A connected customer key was resolved for this run.
      resolveCredential: async () => ({ value: "customer-key", source: "user_connection" }),
      fetchUpstream: async (_input, init) => {
        attempts.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json({ error: { message: "invalid api key" } }, { status: 401 });
      },
    }).request("/api/provider/openrouter/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sandbox-capability" },
      body: JSON.stringify({ model: run.model }),
    });

    // The provider's real 401 is proxied back; the gateway does not retry with a
    // different (house) key - that would silently bill the wrong account.
    expect(response.status).toBe(401);
    expect(attempts).toEqual(["Bearer customer-key"]);
  });

  test("enforces throughput-first, tool-capable routing for Kimi K3", async () => {
    let forwardedBody = "";
    const kimiRun = { ...run, model: KIMI_K3_MODEL };
    const response = await app({
      activeRun: kimiRun,
      fetchUpstream: async (_input, init) => {
        forwardedBody = String(init?.body ?? "");
        return Response.json({ ok: true });
      },
    }).request("/api/provider/openrouter/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: KIMI_K3_MODEL,
        messages: [],
        tools: [{ type: "function", function: { name: "browser_navigate" } }],
        provider: { only: ["fireworks/fast"] },
      }),
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(forwardedBody).provider).toEqual({
      sort: "throughput",
      require_parameters: true,
      allow_fallbacks: true,
    });
  });

  test("proxies successful Anthropic message and token-count protocols", async () => {
    const seen: Array<{ body: string; headers: Headers; url: string }> = [];
    const fetchUpstream = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        body: String(init?.body ?? ""),
        headers: new Headers(init?.headers),
        url: String(input),
      });
      return Response.json({ ok: true });
    };
    const token = { ...claims, engine: "claude" as const, provider: "anthropic" as const };
    const activeRun = { ...run, engine: "claude" as const, model: "claude-opus-5" };
    const routes = app({ token, activeRun, fetchUpstream });

    const messages = await routes.request("/api/provider/anthropic/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer capability", "anthropic-beta": "context-1m" },
      body: JSON.stringify({ model: activeRun.model, messages: [] }),
    });
    const count = await routes.request("/api/provider/anthropic/v1/messages/count_tokens", {
      method: "POST",
      headers: { "x-api-key": "capability" },
      body: JSON.stringify({ model: activeRun.model, messages: [] }),
    });

    expect([messages.status, count.status]).toEqual([200, 200]);
    expect(seen.map(({ url }) => url)).toEqual([
      "https://api.anthropic.com/v1/messages",
      "https://api.anthropic.com/v1/messages/count_tokens",
    ]);
    expect(seen.every(({ headers }) => headers.get("x-api-key") === "real-upstream-key")).toBe(true);
    expect(seen[0]!.headers.get("authorization")).toBeNull();
    expect(JSON.parse(seen[0]!.body).max_tokens).toBe(65_536);
  });

  test("proxies successful OpenAI responses, compaction and model discovery", async () => {
    const seen: Array<{ body: string; headers: Headers; url: string }> = [];
    const fetchUpstream = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        body: String(init?.body ?? ""),
        headers: new Headers(init?.headers),
        url: String(input),
      });
      return Response.json({ ok: true });
    };
    const token = { ...claims, engine: "codex" as const, provider: "openai" as const };
    const activeRun = { ...run, engine: "codex" as const, model: "gpt-5.6-sol" };
    const routes = app({ token, activeRun, fetchUpstream });

    const responses = await routes.request("/api/provider/openai/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer capability" },
      body: JSON.stringify({ model: activeRun.model, input: "hello" }),
    });
    const compact = await routes.request("/api/provider/openai/v1/responses/compact", {
      method: "POST",
      headers: { authorization: "Bearer capability" },
      body: JSON.stringify({ model: activeRun.model, input: [] }),
    });
    const models = await routes.request("/api/provider/openai/v1/models", {
      headers: { authorization: "Bearer capability" },
    });

    expect([responses.status, compact.status, models.status]).toEqual([200, 200, 200]);
    expect(seen.map(({ url }) => url)).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses/compact",
      "https://api.openai.com/v1/models",
    ]);
    expect(
      seen.every(({ headers }) => headers.get("authorization") === "Bearer real-upstream-key"),
    ).toBe(true);
    expect(JSON.parse(seen[0]!.body).max_output_tokens).toBe(65_536);
  });

  test("OpenCode OpenAI-native models spend OpenAI credentials and strip the catalog prefix upstream", async () => {
    const captured: { body: string; url: string; credentialInput: unknown } = {
      body: "",
      url: "",
      credentialInput: null,
    };
    const token = { ...claims, provider: "openai" as const };
    const activeRun = { ...run, model: "openai/gpt-5.6-sol" };
    const response = await app({
      token,
      activeRun,
      resolveCredential: async (input) => {
        captured.credentialInput = input;
        return { value: "user-openai-key", source: "user_connection" };
      },
      fetchUpstream: async (input, init) => {
        captured.body = String(init?.body ?? "");
        captured.url = String(input);
        return Response.json({ ok: true });
      },
    }).request("/api/provider/openai/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer capability" },
      body: JSON.stringify({ model: activeRun.model, input: "hello" }),
    });

    expect(response.status).toBe(200);
    expect(captured.credentialInput).toMatchObject({
      userId: claims.userId,
      provider: "openai",
    });
    expect(captured.url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(captured.body)).toMatchObject({
      model: "gpt-5.6-sol",
      max_output_tokens: 65_536,
    });
  });

  test("preserves upstream retry guidance after the gateway budget is exhausted", async () => {
    const previous = process.env.PROVIDER_GATEWAY_MAX_RETRIES;
    process.env.PROVIDER_GATEWAY_MAX_RETRIES = "0";
    try {
    const token = { ...claims, engine: "codex" as const, provider: "openai" as const };
    const activeRun = { ...run, engine: "codex" as const, model: "gpt-5.6-sol" };
    const routes = app({
      token,
      activeRun,
      fetchUpstream: async () => new Response(
        JSON.stringify({ error: { message: "rate limited" } }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "7",
            "x-should-retry": "false",
            "x-ratelimit-limit-requests": "500",
            "x-ratelimit-remaining-requests": "0",
            "x-ratelimit-reset-requests": "7s",
          },
        },
      ),
    });

    const response = await routes.request("/api/provider/openai/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer capability" },
      body: JSON.stringify({ model: activeRun.model, input: "hello" }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("x-ratelimit-limit-requests")).toBe("500");
    expect(response.headers.get("x-ratelimit-remaining-requests")).toBe("0");
    expect(response.headers.get("x-ratelimit-reset-requests")).toBe("7s");
    } finally {
      if (previous === undefined) delete process.env.PROVIDER_GATEWAY_MAX_RETRIES;
      else process.env.PROVIDER_GATEWAY_MAX_RETRIES = previous;
    }
  });

  test("forwards the gateway's synthesized terminal-quota retry stop", async () => {
    let calls = 0;
    const token = { ...claims, engine: "codex" as const, provider: "openai" as const };
    const activeRun = { ...run, engine: "codex" as const, model: "gpt-5.6-sol" };
    const routes = app({
      token,
      activeRun,
      fetchUpstream: async () => {
        calls += 1;
        return Response.json({
          error: {
            code: "insufficient_quota",
            message: "You have no credits remaining.",
          },
        }, { status: 429 });
      },
    });

    const response = await routes.request("/api/provider/openai/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer capability" },
      body: JSON.stringify({ model: activeRun.model, input: "hello" }),
    });

    expect(calls).toBe(1);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.json()).toEqual({
      error: {
        code: "insufficient_quota",
        message: "You have no credits remaining.",
      },
    });
  });

  test("fails closed when credentials or durable admission are unavailable", async () => {
    const noCredential = await app({ credential: null }).request(
      "/api/provider/openrouter/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: run.model }) },
    );
    expect(noCredential.status).toBe(503);
    expect(await noCredential.json()).toEqual({ error: "provider_not_configured" });

    const exhausted = await app({
      beginAudit: async () => {
        throw new ProviderGatewayAdmissionError("concurrency_exhausted");
      },
    }).request(
      "/api/provider/openrouter/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: run.model }) },
    );
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toEqual({ error: "concurrency_exhausted" });
    expect(exhausted.headers.get("retry-after")).toBe("1");

    const unavailable = await app({
      beginAudit: async () => {
        throw new Error("database offline");
      },
    }).request(
      "/api/provider/openrouter/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: run.model }) },
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "audit_unavailable" });
  });
});

describe("thread-scoped capabilities (run-invariant config)", () => {
  const threadClaims: ProviderTokenClaims = { ...claims, scope: "thread" };
  const okUpstream = async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

  test("authorizes via the thread's LIVE run for the signed user", async () => {
    const laterTurn: GatewayRun = { ...run, id: "run-later" };
    const response = await app({
      token: threadClaims,
      activeThreadRun: laterTurn,
      fetchUpstream: okUpstream,
    }).request("/api/provider/openrouter/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: run.model }),
    });
    expect(response.status).toBe(200);
  });

  test("fails closed when the thread's LIVE run belongs to another user", async () => {
    // The live run is a DIFFERENT run id and a DIFFERENT user than the minting
    // turn: thread scope must not let another actor spend the signed user's
    // provider capability.
    const laterTurn: GatewayRun = { ...run, id: "run-later", userId: "user-b" };
    const response = await app({
      token: threadClaims,
      activeThreadRun: laterTurn,
      fetchUpstream: okUpstream,
    }).request("/api/provider/openrouter/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: run.model }),
    });
    expect(response.status).toBe(403);
  });

  test("is inert when the thread has no live turn (fail closed)", async () => {
    const response = await app({ token: threadClaims, activeThreadRun: null }).request(
      "/api/provider/openrouter/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: run.model }) },
    );
    expect(response.status).toBe(403);
  });

  test("still enforces org/thread/engine binding against the resolved run", async () => {
    const foreign: GatewayRun = { ...run, threadId: "thread-other" };
    const response = await app({ token: threadClaims, activeThreadRun: foreign }).request(
      "/api/provider/openrouter/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: run.model }) },
    );
    expect(response.status).toBe(403);
  });

  test("still enforces the resolved run's model policy", async () => {
    const response = await app({ token: threadClaims, activeThreadRun: run }).request(
      "/api/provider/openrouter/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: "openai/not-authorized" }) },
    );
    expect(response.status).toBe(403);
  });

  test("run-scoped tokens NEVER use thread resolution (exact-run binding intact)", async () => {
    // findRunningRun returns null; even with a live thread run available, a
    // run-scoped token must not fall back to it.
    const response = await app({ activeRun: null, activeThreadRun: run }).request(
      "/api/provider/openrouter/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: run.model }) },
    );
    expect(response.status).toBe(403);
  });
});
