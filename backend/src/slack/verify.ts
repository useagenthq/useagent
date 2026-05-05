/**
 * Slack request-signature verification (Events API v0 scheme).
 *
 * QM delegated this to `@slack/bolt`'s `isValidSlackRequest`; we implement the
 * documented HMAC directly so the adapter carries no Bolt/Socket-Mode weight.
 * The signed base string is `v0:<timestamp>:<raw body>`, HMAC-SHA256'd with the
 * signing secret; the hex digest prefixed `v0=` must equal `X-Slack-Signature`.
 * A timestamp older than 5 minutes is rejected (replay guard).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SKEW_SECONDS = 60 * 5;

export interface SignatureInput {
  signingSecret: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  body: string;
  /** Injectable clock (seconds) for tests; defaults to wall clock. */
  nowSeconds?: number;
}

export function verifySlackSignature(input: SignatureInput): boolean {
  const { signingSecret, signature, timestamp, body } = input;
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  const now = input.nowSeconds ?? Date.now() / 1000;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_SECONDS) return false;

  const expected =
    "v0=" +
    createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex");

  // Constant-time compare; lengths must match for timingSafeEqual.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
