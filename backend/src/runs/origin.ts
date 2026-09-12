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

export const AUTOMATION_RUN_ORIGIN = "product:automation" as const;
export const BOT_HANDOFF_RUN_ORIGIN = "product:bot-handoff" as const;
export const UNATTENDED_RUN_ORIGINS = [
  AUTOMATION_RUN_ORIGIN,
  BOT_HANDOFF_RUN_ORIGIN,
] as const;
export type UnattendedRunOrigin = (typeof UNATTENDED_RUN_ORIGINS)[number];
export type TrustedRunOrigin = InternalRunOrigin | UnattendedRunOrigin;

const INTERNAL_RUN_ORIGIN_SET = new Set<string>(INTERNAL_RUN_ORIGINS);
const UNATTENDED_RUN_ORIGIN_SET = new Set<string>(UNATTENDED_RUN_ORIGINS);

export function isInternalRunOrigin(origin: string | null): origin is InternalRunOrigin {
  return origin !== null && INTERNAL_RUN_ORIGIN_SET.has(origin);
}

export function assertInternalRunOrigin(origin: string): asserts origin is InternalRunOrigin {
  if (!isInternalRunOrigin(origin)) {
    throw new Error(`untrusted internal run origin: ${origin}`);
  }
}

export function isUnattendedRunOrigin(origin: string | null): origin is UnattendedRunOrigin {
  return origin !== null && UNATTENDED_RUN_ORIGIN_SET.has(origin);
}

export function assertUnattendedRunOrigin(origin: string): asserts origin is UnattendedRunOrigin {
  if (!isUnattendedRunOrigin(origin)) {
    throw new Error(`untrusted unattended run origin: ${origin}`);
  }
}
