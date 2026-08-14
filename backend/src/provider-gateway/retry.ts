type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const DEFAULT_MAX_RETRIES = 2;
const MAX_CONFIGURED_RETRIES = 10;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
const MAX_RETRY_AFTER_MS = 60_000;

export interface ProviderRetryOptions {
  readonly fetch: FetchLike;
  readonly maxRetries?: number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number, signal?: AbortSignal | null) => Promise<void>;
  readonly onRetry?: (details: {
    attempt: number;
    delayMs: number;
    status: number | null;
  }) => void;
}

export function providerGatewayMaxRetries(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.PROVIDER_GATEWAY_MAX_RETRIES?.trim();
  if (!raw) return DEFAULT_MAX_RETRIES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_MAX_RETRIES;
  return Math.min(parsed, MAX_CONFIGURED_RETRIES);
}

export function shouldRetryProviderResponse(response: Response): boolean {
  const directive = response.headers.get("x-should-retry")?.trim().toLowerCase();
  if (directive === "true") return true;
  if (directive === "false") return false;
  return response.status === 408 ||
    response.status === 409 ||
    response.status === 429 ||
    response.status >= 500;
}

function retryAfterMs(headers: Headers, nowMs = Date.now()): number | null {
  const precise = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(precise) && precise > 0 && precise <= MAX_RETRY_AFTER_MS) {
    return precise;
  }

  const raw = headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(raw) - nowMs;
  return Number.isFinite(delay) && delay > 0 && delay <= MAX_RETRY_AFTER_MS
    ? delay
    : null;
}

export function providerRetryDelayMs(
  retryIndex: number,
  headers: Headers | null,
  random: () => number = Math.random,
): number {
  const requested = headers ? retryAfterMs(headers) : null;
  if (requested !== null) return requested;
  const exponential = Math.min(
    INITIAL_RETRY_DELAY_MS * (2 ** Math.max(0, retryIndex)),
    MAX_RETRY_DELAY_MS,
  );
  return Math.round(exponential * (1 - 0.25 * random()));
}

async function abortableSleep(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Retry upstream API work before any response is exposed to the sandbox. This
 * mirrors the official OpenAI SDK retry class (connection failures, 408, 409,
 * 429, and 5xx) and prevents an agent-level retry from replaying completed tools.
 */
export async function fetchProviderUpstream(
  input: string | URL | Request,
  init: RequestInit,
  options: ProviderRetryOptions,
): Promise<Response> {
  const maxRetries = options.maxRetries ?? providerGatewayMaxRetries();
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;

  for (let attempt = 0;; attempt += 1) {
    let response: Response;
    try {
      response = await options.fetch(input, init);
    } catch (error) {
      if (init.signal?.aborted || attempt >= maxRetries) throw error;
      const delayMs = providerRetryDelayMs(attempt, null, random);
      options.onRetry?.({ attempt: attempt + 1, delayMs, status: null });
      await sleep(delayMs, init.signal);
      continue;
    }

    if (attempt >= maxRetries || !shouldRetryProviderResponse(response)) {
      return response;
    }

    const delayMs = providerRetryDelayMs(attempt, response.headers, random);
    options.onRetry?.({ attempt: attempt + 1, delayMs, status: response.status });
    await response.body?.cancel().catch(() => undefined);
    await sleep(delayMs, init.signal);
  }
}
