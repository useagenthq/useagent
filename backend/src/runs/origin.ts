// Internal run authority is explicit and server-owned. Public callers never
// supply an origin; private canaries and descendants of trusted internal runs
// use one of these exact values. Identifier and idempotency-key prefixes are
// deliberately irrelevant.

export const MODEL_QUALIFICATION_RUN_ORIGIN = "internal:model-qualification" as const;

export const INTERNAL_RUN_ORIGINS = [
  "internal:release-parity",
  "internal:eval",
  "internal:canary",
  "internal:hosted-release-canary",
  "internal:e2e",
  MODEL_QUALIFICATION_RUN_ORIGIN,
] as const;

export type InternalRunOrigin = (typeof INTERNAL_RUN_ORIGINS)[number];

const INTERNAL_RUN_ORIGIN_SET = new Set<string>(INTERNAL_RUN_ORIGINS);

export function isInternalRunOrigin(origin: string | null): origin is InternalRunOrigin {
  return origin !== null && INTERNAL_RUN_ORIGIN_SET.has(origin);
}

export function assertInternalRunOrigin(origin: string): asserts origin is InternalRunOrigin {
  if (!isInternalRunOrigin(origin)) {
    throw new Error(`untrusted internal run origin: ${origin}`);
  }
}
