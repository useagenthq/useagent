import { env } from "./env";

/**
 * Embedding client — ported from the knowledge service
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

/** True when embeddings are available (a key is configured). */
export function embeddingsEnabled(): boolean {
  return env.embed.apiKey !== null;
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
      return rows;
    } catch (e) {
      lastErr = e;
      if (attempt === 4) throw e;
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
