import { describe, expect, test } from "bun:test";
import { signWebhookPayload, verifyWebhookSignature } from "./signature";

describe("webhook signatures", () => {
  test("uses the sha256-prefixed HMAC-SHA256 format", () => {
    expect(signWebhookPayload("\x0b".repeat(20), "Hi There")).toBe(
      "sha256=b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  test("verifies the exact payload and rejects a changed payload or signature", () => {
    const secret = "webhook-secret";
    const payload = '{"event":"run.completed","run_id":"run-1"}';
    const signature = signWebhookPayload(secret, payload);

    expect(verifyWebhookSignature(secret, payload, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, `${payload} `, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, payload, "sha256=invalid")).toBe(false);
  });
});
