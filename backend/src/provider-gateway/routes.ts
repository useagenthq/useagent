import { Hono, type Context } from "hono";
import {
  beginProviderGatewayAudit,
  finishProviderGatewayAudit,
  ProviderGatewayAdmissionError,
} from "./audit";
import { resolveProviderCredential } from "./credentials";
import { providerForEngine, type ProviderId } from "./provider";
import { providerRequestLimits } from "./limits";
import { applyProviderBodyPolicy, type OutputLimitField } from "./request-policy";
import {
  findActiveThreadGatewayRun,
  findRunningGatewayRun,
  type GatewayRun,
} from "./run-authorization";
import { verifyProviderToken, type ProviderTokenClaims } from "./token";
import { runtimeDevModeEnabled } from "../security/runtime-secrets";
import { applyOpenRouterProviderRouting } from "./provider-routing";
import { fetchProviderUpstream, providerGatewayMaxRetries } from "./retry";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

interface ProviderRouteDeps {
  readonly verifyToken?: typeof verifyProviderToken;
  readonly findRunningRun?: typeof findRunningGatewayRun;
  readonly findActiveThreadRun?: typeof findActiveThreadGatewayRun;
  readonly resolveCredential?: typeof resolveProviderCredential;
  readonly fetchUpstream?: FetchLike;
  readonly beginAudit?: typeof beginProviderGatewayAudit;
  readonly finishAudit?: typeof finishProviderGatewayAudit;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface RouteTarget {
  readonly provider: ProviderId;
  readonly upstreamPath: string;
  readonly outputLimitField: OutputLimitField;
}

const UPSTREAM_ORIGINS: Record<ProviderId, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  openrouter: "https://openrouter.ai/api",
};

export function providerUpstreamOrigin(
  provider: ProviderId,
  env: Record<string, string | undefined> = process.env,
): string {
  const envName = `${provider.toUpperCase()}_UPSTREAM_BASE_URL`;
  const configured = env[envName]?.trim();
  const raw = (configured || UPSTREAM_ORIGINS[provider]).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${envName} must be an absolute URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${envName} must not include credentials, query, or fragment`);
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && runtimeDevModeEnabled(env))) {
    throw new Error(`${envName} requires HTTPS (HTTP is local-development loopback only)`);
  }
  if (configured && !runtimeDevModeEnabled(env) && raw !== UPSTREAM_ORIGINS[provider]) {
    const allowlist = new Set(
      (env.PROVIDER_GATEWAY_UPSTREAM_HOSTS ?? "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    );
    if (!allowlist.has(url.host.toLowerCase())) {
      throw new Error(`${envName} host is not in PROVIDER_GATEWAY_UPSTREAM_HOSTS`);
    }
  }
  return raw;
}

function presentedToken(headers: Headers): string | null {
  const authorization = headers.get("authorization")?.trim();
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim() || null;
  }
  return headers.get("x-api-key")?.trim() || null;
}

function requestHeaders(provider: ProviderId, incoming: Headers, credential: string): Headers {
  const headers = new Headers({
    accept: incoming.get("accept") ?? "application/json",
    "content-type": incoming.get("content-type") ?? "application/json",
  });
  if (provider === "anthropic") {
    headers.set("x-api-key", credential);
    headers.set("anthropic-version", incoming.get("anthropic-version") ?? "2023-06-01");
    const beta = incoming.get("anthropic-beta");
    if (beta) headers.set("anthropic-beta", beta);
  } else {
    headers.set("authorization", `Bearer ${credential}`);
  }
  if (provider === "openrouter") {
    const referer = process.env.OPENROUTER_HTTP_REFERER?.trim();
    const title = process.env.OPENROUTER_APP_TITLE?.trim();
    if (referer) headers.set("http-referer", referer);
    if (title) headers.set("x-title", title);
  }
  return headers;
}

function responseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of [
    "content-type",
    "cache-control",
    "retry-after",
    "x-should-retry",
    "x-request-id",
    "request-id",
    "x-ratelimit-limit-requests",
    "x-ratelimit-limit-tokens",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
  ]) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function authorizedRun(
  claims: ProviderTokenClaims,
  target: RouteTarget,
  run: GatewayRun | null,
): run is GatewayRun {
  if (!run || claims.provider !== target.provider) return false;
  if (
    run.orgId !== claims.orgId ||
    run.threadId !== claims.threadId ||
    run.engine !== claims.engine
  ) {
    return false;
  }
  // "run" scope binds to the exact minted turn. "thread" scope resolves the
  // thread's live run per request, but still binds to the signed user: a warm
  // runtime token must not be spendable by a later turn from another actor.
  if ((run.userId ?? "") !== claims.userId) return false;
  if (claims.scope === "run") {
    if (run.id !== claims.issuedRunId) {
      return false;
    }
  }
  return providerForEngine(run.engine, run.model) === target.provider;
}

function responseBodyWithRelease(
  body: ReadableStream<Uint8Array> | null,
  release: () => void,
): ReadableStream<Uint8Array> | null {
  if (!body) {
    release();
    return null;
  }
  const reader = body.getReader();
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export function createProviderGatewayRoutes(deps: ProviderRouteDeps = {}): Hono {
  const verifyToken = deps.verifyToken ?? verifyProviderToken;
  const findRunningRun = deps.findRunningRun ?? findRunningGatewayRun;
  const findActiveThreadRun = deps.findActiveThreadRun ?? findActiveThreadGatewayRun;
  const resolveCredential = deps.resolveCredential ?? resolveProviderCredential;
  const fetchUpstream: FetchLike = deps.fetchUpstream ?? fetch;
  const beginAudit = deps.beginAudit ?? beginProviderGatewayAudit;
  const finishAudit = deps.finishAudit ?? finishProviderGatewayAudit;
  const routes = new Hono();

  const proxy = (target: RouteTarget) => async (c: Context) => {
    const claims = verifyToken(presentedToken(c.req.raw.headers));
    if (!claims) return c.json({ error: "unauthorized" }, 401);

    // "run" scope: the exact minted turn must be live. "thread" scope: resolve
    // the thread's single live turn (fail closed on none or - invariant breach -
    // more than one); enforcement below keys to the resolved run.
    const run =
      claims.scope === "thread"
        ? await findActiveThreadRun({
            orgId: claims.orgId,
            threadId: claims.threadId,
            engine: claims.engine,
          })
        : await findRunningRun({
            runId: claims.issuedRunId,
            orgId: claims.orgId,
            threadId: claims.threadId,
            engine: claims.engine,
          });
    if (!authorizedRun(claims, target, run)) return c.json({ error: "forbidden" }, 403);

    const limits = providerRequestLimits();

    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return c.json({ error: "request_too_large" }, 413);
    }
    const rawBody = c.req.method === "GET" ? "" : await c.req.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return c.json({ error: "request_too_large" }, 413);
    }
    let upstreamBody = rawBody;
    let requestedOutputTokens = 0;
    if (rawBody) {
      const policy = applyProviderBodyPolicy(
        run,
        rawBody,
        target.outputLimitField,
        limits.maxOutputTokens,
      );
      if (!policy.ok) {
        const status = policy.error === "invalid_json" ? 400 : 403;
        return c.json({ error: policy.error }, status);
      }
      upstreamBody = policy.body;
      requestedOutputTokens = policy.requestedOutputTokens;
    }
    if (target.provider === "openrouter") {
      upstreamBody = applyOpenRouterProviderRouting(run.model, upstreamBody);
    }

    const credential = await resolveCredential(claims.orgId, target.provider);
    if (!credential) {
      return c.json({ error: "provider_not_configured" }, 503);
    }

    const auditId = `provider_gateway_${crypto.randomUUID()}`;
    const requestedAt = Date.now();
    try {
      await beginAudit(
        {
          id: auditId,
          runId: run.id,
          orgId: claims.orgId,
          provider: target.provider,
          path: target.upstreamPath,
          model: run.model,
          requestedOutputTokens,
        },
        limits,
      );
    } catch (error) {
      if (error instanceof ProviderGatewayAdmissionError) {
        const headers = error.reason === "concurrency_exhausted"
          ? { "retry-after": "1" }
          : undefined;
        return c.json({ error: error.reason }, 429, headers);
      }
      console.error(
        `[provider-gateway] audit start failed for run ${run.id}:`,
        error instanceof Error ? error.message : error,
      );
      return c.json({ error: "audit_unavailable" }, 503);
    }

    try {
      const upstreamSignal = AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(limits.upstreamTimeoutMs),
      ]);
      const upstream = await fetchProviderUpstream(
        `${providerUpstreamOrigin(target.provider)}${target.upstreamPath}${new URL(c.req.url).search}`,
        {
          method: c.req.method,
          headers: requestHeaders(target.provider, c.req.raw.headers, credential),
          body: upstreamBody || undefined,
          redirect: "error",
          signal: upstreamSignal,
        },
        {
          fetch: fetchUpstream,
          maxRetries: providerGatewayMaxRetries(),
          onRetry: ({ attempt, delayMs, status }) => {
            console.warn(
              `[provider-gateway] retry ${attempt} for run ${run.id} after ${status ?? "connection error"} (${delayMs}ms)`,
            );
          },
        },
      );
      const completeAudit = () => {
        void finishAudit({
          id: auditId,
          outcome: "responded",
          upstreamStatus: upstream.status,
          durationMs: Date.now() - requestedAt,
        }).catch((error) => {
          console.error(
            `[provider-gateway] audit completion failed for run ${run.id}:`,
            error instanceof Error ? error.message : error,
          );
        });
      };
      return new Response(responseBodyWithRelease(upstream.body, completeAudit), {
        status: upstream.status,
        headers: responseHeaders(upstream.headers),
      });
    } catch (error) {
      await finishAudit({
        id: auditId,
        outcome: "failed",
        durationMs: Date.now() - requestedAt,
      }).catch(() => undefined);
      console.error(
        `[provider-gateway] ${target.provider} request failed for run ${run.id}:`,
        error instanceof Error ? error.message : error,
      );
      return c.json({ error: "provider_unavailable" }, 502);
    }
  };

  routes.post(
    "/anthropic/v1/messages",
    proxy({ provider: "anthropic", upstreamPath: "/v1/messages", outputLimitField: "max_tokens" }),
  );
  routes.post(
    "/anthropic/v1/messages/count_tokens",
    proxy({ provider: "anthropic", upstreamPath: "/v1/messages/count_tokens", outputLimitField: null }),
  );
  routes.post(
    "/openai/v1/responses",
    proxy({ provider: "openai", upstreamPath: "/v1/responses", outputLimitField: "max_output_tokens" }),
  );
  routes.post(
    "/openai/v1/responses/compact",
    proxy({ provider: "openai", upstreamPath: "/v1/responses/compact", outputLimitField: null }),
  );
  routes.get(
    "/openai/v1/models",
    proxy({ provider: "openai", upstreamPath: "/v1/models", outputLimitField: null }),
  );
  routes.post(
    "/openrouter/v1/chat/completions",
    proxy({ provider: "openrouter", upstreamPath: "/v1/chat/completions", outputLimitField: "max_tokens" }),
  );
  return routes;
}

export const providerGatewayRoutes = createProviderGatewayRoutes();
