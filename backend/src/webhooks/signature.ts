import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhookPayload(secret: string, payload: string): string {
  const digest = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(secret: string, payload: string, signature: string): boolean {
  const expected = Buffer.from(signWebhookPayload(secret, payload), "utf8");
  const supplied = Buffer.from(signature, "utf8");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
