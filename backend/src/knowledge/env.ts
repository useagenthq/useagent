/**
 * Typed environment access for the knowledge module. Ported in spirit from
 * the knowledge service's packages/config, but every key is OPTIONAL: missing
 * LLM/embedding keys degrade gracefully (stub distillation + keyword-only
 * search) instead of throwing. Bun auto-loads backend/.env.
 */
function opt(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  /** Postgres — the retrieval store (tsvector + pgvector). */
  databaseUrl: opt("DATABASE_URL", "postgres://postgres@localhost:5432/skynet"),

  /** Default org when the caller resolves none (headers wired later). */
  defaultOrg: opt("KNOWLEDGE_DEFAULT_ORG", "skynet-dev"),

  /** Distillation LLM — OpenRouter (OpenAI-compatible). Absent key → stub. */
  distill: {
    get baseUrl() {
      return opt("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
    },
    get apiKey(): string | null {
      return process.env.OPENROUTER_API_KEY ?? null;
    },
    get model() {
      return opt("DISTILL_MODEL", "z-ai/glm-5.2");
    },
  },

  /** Embeddings — OpenAI text-embedding-3-large @ 1024 dims. Absent key → no vectors. */
  embed: {
    get baseUrl() {
      return opt("OPENAI_BASE_URL", "https://api.openai.com/v1");
    },
    get apiKey(): string | null {
      return process.env.OPENAI_API_KEY ?? null;
    },
    get model() {
      return opt("EMBED_MODEL", "text-embedding-3-large");
    },
    get dimensions() {
      return Number(opt("EMBED_DIMENSIONS", "1024"));
    },
  },
} as const;

/** Vector column dimensionality — the store column and embeddings must agree. */
export const EMBED_DIMS = 1024;
