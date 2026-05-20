type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const DEFAULT_MAX_RETRIES = 2;
const MAX_CONFIGURED_RETRIES = 10;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_ERROR_CLASSIFICATION_BYTES = 64 * 1024;
const MAX_ERROR_CLASSIFICATION_MS = 100;

const TERMINAL_QUOTA_MARKERS = [
  "insufficient_quota",
  "billing_hard_limit_reached",
  "no credits remaining",
  "add credits to continue",
  "exceeded your current quota",
  "credit balance is too low",
  "billing hard limit",
] as const;

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

async function cancelResponseReader(
  reader: Pick<ReadableStreamDefaultReader<unknown>, "cancel">,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best-effort and must not reject after classification returns.
  }
}

async function responseBodyPrefix(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  const timeout = Symbol("timeout");
  const deadline = Promise.withResolvers<typeof timeout>();
  const timer = setTimeout(() => deadline.resolve(timeout), MAX_ERROR_CLASSIFICATION_MS);
  try {
    while (bytesRead < MAX_ERROR_CLASSIFICATION_BYTES) {
      const result = await Promise.race([reader.read(), deadline.promise]);
      if (result === timeout) break;
      const { done, value } = result;
      if (done) break;
      const remaining = MAX_ERROR_CLASSIFICATION_BYTES - bytesRead;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += chunk.byteLength;
      text += decoder.decode(chunk, { stream: bytesRead < MAX_ERROR_CLASSIFICATION_BYTES });
      if (chunk.byteLength < value.byteLength) break;
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
    void cancelResponseReader(reader);
  }
}

function withRetryDirective(response: Response, shouldRetry: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("x-should-retry", String(shouldRetry));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

interface RetryAfterDecision {
  readonly delayMs: number | null;
  readonly oversized: boolean;
}

function retryAfterDecision(headers: Headers, nowMs = Date.now()): RetryAfterDecision {
  const preciseRaw = headers.get("retry-after-ms")?.trim();
  const precise = Number(preciseRaw);
  if (preciseRaw && Number.isFinite(precise) && precise > 0) {
    return precise <= MAX_RETRY_AFTER_MS
      ? { delayMs: precise, oversized: false }
      : { delayMs: null, oversized: true };
  }

  const raw = headers.get("retry-after")?.trim();
  if (!raw) return { delayMs: null, oversized: false };
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(raw) - nowMs;
  if (!Number.isFinite(delay) || delay <= 0) {
    return { delayMs: null, oversized: false };
  }
  return delay <= MAX_RETRY_AFTER_MS
    ? { delayMs: delay, oversized: false }
    : { delayMs: null, oversized: true };
}

async function isTerminalProviderResponse(response: Response): Promise<boolean> {
  if (response.headers.has("x-should-retry")) return false;
  if (response.status === 401 || response.status === 402 || response.status === 403) return true;
  if (shouldRetryProviderResponse(response) && retryAfterDecision(response.headers).oversized) {
    return true;
  }
  if (response.status !== 429) return false;
  const body = (await responseBodyPrefix(response)).toLowerCase();
  return TERMINAL_QUOTA_MARKERS.some((marker) => body.includes(marker));
}

export function providerRetryDelayMs(
  retryIndex: number,
  headers: Headers | null,
  random: () => number = Math.random,
): number {
  const requested = headers ? retryAfterDecision(headers).delayMs : null;
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

    const retryable = shouldRetryProviderResponse(response);
    // Once the gateway budget is exhausted, classification cannot change the
    // decision. Return immediately instead of waiting up to 100 ms for a cloned
    // 429 body that the downstream caller still needs to consume.
    if (retryable && attempt >= maxRetries) {
      return withRetryDirective(response, false);
    }

    if (await isTerminalProviderResponse(response)) {
      return withRetryDirective(response, false);
    }

    if (!retryable) {
      return response;
    }

    const delayMs = providerRetryDelayMs(attempt, response.headers, random);
    options.onRetry?.({ attempt: attempt + 1, delayMs, status: response.status });
    await response.body?.cancel().catch(() => undefined);
    await sleep(delayMs, init.signal);
  }
}
