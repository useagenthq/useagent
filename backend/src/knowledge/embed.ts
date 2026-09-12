import { env } from "./env";

/**
 * Embedding client — part of the knowledge service
 * (packages/embedding/src/index.ts). OpenAI text-embedding-3-large @ 1024 dims,
 * called directly (we bring our own vectors to Postgres/pgvector). Adapted to
 * degrade to NULL when OPENAI_API_KEY is absent, so ingest still stores records
 * (embedding column null) and search falls back to keyword-only.
 */
export class EmbedError extends Error {}

const TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS) || 60_000;

interface EmbeddingResponse {
  data?: Array<{ embedding: number[]; index: number }>;
  error?: { message?: string };
}

/** True when an embedding key is configured. Configuration alone does not make
 *  search hybrid: see embeddingsAvailable(). */
export function embeddingsEnabled(): boolean {
  return env.embed.apiKey !== null;
}

// Health is observed, not assumed: a configured key that the provider rejects
// (or that cannot be reached) leaves every ingest and search keyword-only, and
// the API must say so instead of reporting embeddings as on. The last failure
// is remembered until the next embedding succeeds.
let lastEmbedFailure: string | null = null;

export function markEmbeddingsHealthy(): void {
  lastEmbedFailure = null;
}

export function markEmbeddingsDegraded(reason: string): void {
  lastEmbedFailure = reason;
}

/** Why search is keyword-only right now, or null when embeddings serve. */
export function embeddingsUnavailableReason(): string | null {
  if (!embeddingsEnabled()) return "no embedding key is configured";
  return lastEmbedFailure ? `the embedding provider failed (${lastEmbedFailure})` : null;
}

/** True only when a key is configured AND the last embedding call succeeded. */
export function embeddingsAvailable(): boolean {
  return embeddingsUnavailableReason() === null;
}

/**
 * Embed one or more texts. Returns null when no key is configured (keyword-only
 * degrade). Batches in one request; retries transient failures; hard deadline.
 */
export async function embed(input: string | string[]): Promise<number[][] | null> {
  const apiKey = env.embed.apiKey;
  if (!apiKey) return null;

  const texts = Array.isArray(input) ? input : [input];
  if (texts.length === 0) return [];

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${env.embed.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: env.embed.model, input: texts, dimensions: env.embed.dimensions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) throw new EmbedError(`openai embeddings ${res.status}`);
      const body = (await res.json()) as EmbeddingResponse;
      if (!res.ok || body.error) throw new EmbedError(`openai embeddings: ${body.error?.message ?? res.status}`);
      const rows = (body.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
      if (rows.length !== texts.length) throw new EmbedError(`embedding count ${rows.length} != ${texts.length}`);
      markEmbeddingsHealthy();
      return rows;
    } catch (e) {
      lastErr = e;
      if (attempt === 4) {
        markEmbeddingsDegraded((e as Error).message);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

/** Embed a single text → its vector, or null when embeddings are disabled. */
export async function embedOne(text: string): Promise<number[] | null> {
  const rows = await embed(text);
  if (rows === null) return null;
  const [v] = rows;
  if (!v) throw new EmbedError("no embedding returned");
  return v;
}

/** pgvector text literal: [0.1,0.2,…] — cast with ::vector on the SQL side. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
