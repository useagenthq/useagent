import { botsEnabled } from "../../bots/rollout";
import { productChildThreadsEnabled } from "../../runs/thread-relationship-rollout";
import { errorMessage } from "../../util/error-message";

// ---------------------------------------------------------------------------
// Which product tool families the gateway advertises (child sessions, bot
// handoffs) is a product decision the backend makes. The gateway is a separate
// process with its own env, and a gateway booted without PRODUCT_CHILD_THREADS
// or BOTS used to advertise no such tools while the backend told the agent about
// bots: the agent then reported the tool as unavailable. In bridge mode the
// gateway therefore takes the primary's answer (GET /api/config `product`) and
// only falls back to its own env when the primary cannot be reached, saying so.
// ---------------------------------------------------------------------------

export interface GatewayProductFlags {
  readonly childThreads: boolean;
  readonly bots: boolean;
}

const PRIMARY_FLAGS_TTL_MS = 60_000;
const PRIMARY_FETCH_TIMEOUT_MS = 5_000;
const LOG_INTERVAL_MS = 60_000;

type Env = Readonly<Record<string, string | undefined>>;
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The process's own view, org canary included. */
export function localProductFlags(orgId: string | null, env: Env = process.env): GatewayProductFlags {
  return { childThreads: productChildThreadsEnabled(orgId, env), bots: botsEnabled(orgId, env) };
}

/** The primary API origin in gateway (bridge) mode, null when this process is the primary. */
export function primaryApiOriginFor(env: Env = process.env): string | null {
  if (!env.GATEWAY_DATABASE_URL?.trim()) return null;
  const raw = env.USEAGENT_API_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The `product` block of GET /api/config, or null when the body does not carry one. */
export function parsePrimaryProductFlags(body: unknown): GatewayProductFlags | null {
  if (!body || typeof body !== "object") return null;
  const product = (body as { product?: unknown }).product;
  if (!product || typeof product !== "object") return null;
  const { childThreads, bots } = product as { childThreads?: unknown; bots?: unknown };
  if (typeof childThreads !== "boolean" || typeof bots !== "boolean") return null;
  return { childThreads, bots };
}

interface PrimaryFlagsCache {
  readonly origin: string;
  readonly flags: GatewayProductFlags;
  readonly fetchedAt: number;
}

let cache: PrimaryFlagsCache | null = null;
let inflight: Promise<GatewayProductFlags | null> | null = null;
let lastUnreachableLogAt = 0;
let lastMismatchLogAt = 0;
let fetcherOverride: FetchLike | null = null;

export function resetProductFlagsForTest(): void {
  cache = null;
  inflight = null;
  lastUnreachableLogAt = 0;
  lastMismatchLogAt = 0;
}

/** Pin the primary fetch (the unit suite pins it to an instant failure so no test leaves the process). */
export function setPrimaryProductFlagsFetcherForTest(fetchImpl: FetchLike | null): void {
  fetcherOverride = fetchImpl;
  resetProductFlagsForTest();
}

async function fetchPrimaryProductFlags(origin: string, fetchImpl: FetchLike): Promise<GatewayProductFlags> {
  const response = await fetchImpl(`${origin}/api/config`, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(PRIMARY_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const flags = parsePrimaryProductFlags(await response.json());
  if (!flags) throw new Error("no product block in /api/config (older primary)");
  return flags;
}

async function cachedPrimaryFlags(
  origin: string,
  deps: { readonly fetchImpl: FetchLike; readonly now: () => number },
): Promise<GatewayProductFlags | null> {
  const now = deps.now();
  if (cache && cache.origin === origin && now - cache.fetchedAt < PRIMARY_FLAGS_TTL_MS) return cache.flags;
  inflight ??= fetchPrimaryProductFlags(origin, deps.fetchImpl)
    .then((flags) => {
      cache = { origin, flags, fetchedAt: deps.now() };
      return flags;
    })
    .catch((error: unknown) => {
      if (deps.now() - lastUnreachableLogAt >= LOG_INTERVAL_MS) {
        lastUnreachableLogAt = deps.now();
        console.warn(
          `[gateway] could not read product flags from the primary at ${origin} (${errorMessage(error)}); ` +
            "advertising tool families from this process's own PRODUCT_CHILD_THREADS and BOTS until it answers",
        );
      }
      return cache?.origin === origin ? cache.flags : null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * The tool families to advertise for one org. The primary's answer wins in
 * bridge mode; a disagreement with this process's env is logged at error level
 * on every refresh so the operator fixes the gateway env, and the agent still
 * sees the tools the product enabled.
 */
export async function productFlagsForToolList(
  orgId: string | null,
  deps: { readonly env?: Env; readonly fetchImpl?: FetchLike; readonly now?: () => number } = {},
): Promise<GatewayProductFlags> {
  const env = deps.env ?? process.env;
  const local = localProductFlags(orgId, env);
  const origin = primaryApiOriginFor(env);
  if (!origin) return local;
  const primary = await cachedPrimaryFlags(origin, {
    fetchImpl: deps.fetchImpl ?? fetcherOverride ?? ((input, init) => fetch(input, init)),
    now: deps.now ?? Date.now,
  });
  if (!primary) return local;
  // The primary's block is deployment-wide; a per-org canary allowlist on this
  // process still adds its orgs.
  const canaryOnly = local.childThreads && !productChildThreadsEnabled(null, env);
  const effective: GatewayProductFlags = {
    childThreads: primary.childThreads || canaryOnly,
    bots: primary.bots,
  };
  const now = (deps.now ?? Date.now)();
  if (
    (effective.childThreads !== local.childThreads || effective.bots !== local.bots) &&
    now - lastMismatchLogAt >= LOG_INTERVAL_MS
  ) {
    lastMismatchLogAt = now;
    console.error(
      `[gateway] product flags disagree with the primary at ${origin}: ` +
        `PRODUCT_CHILD_THREADS here=${local.childThreads ? "on" : "off"} primary=${effective.childThreads ? "on" : "off"}, ` +
        `BOTS here=${local.bots ? "on" : "off"} primary=${effective.bots ? "on" : "off"}. ` +
        "Advertising the primary's tool families; give the gateway process the same PRODUCT_CHILD_THREADS and BOTS values.",
    );
  }
  return effective;
}
