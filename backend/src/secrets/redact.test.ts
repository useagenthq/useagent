import { describe, expect, test } from "bun:test";
import { containsSignedCapability, createSecretRedactor } from "./redact";

describe("sandbox output secret redaction", () => {
  test("redacts exact injected values recursively before persistence", () => {
    const redact = createSecretRedactor([
      "super-secret-token-value",
      '{"type":"service_account","private_key":"private-material"}',
    ]);

    expect(
      redact.unknown({
        output: "TOKEN=super-secret-token-value",
        nested: [{ credentials: '{"type":"service_account","private_key":"private-material"}' }],
      }),
    ).toEqual({
      output: "TOKEN=<redacted>",
      nested: [{ credentials: "<redacted>" }],
    });
  });

  test("redacts exact injected values used as dynamic object keys", () => {
    const secret = "SYNTHETIC_DYNAMIC_KEY_SECRET_123456";
    const redact = createSecretRedactor([secret]);
    const payload: unknown = { nested: { [secret]: "safe value" } };

    expect(redact.unknown(payload)).toEqual({
      nested: { "<redacted>": "safe value" },
    });
  });

  test("redacts signed capability tokens even when no org secret is present", () => {
    const redact = createSecretRedactor([]);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJydW5JZCI6InIxIn0.signaturebytes";
    const capability = "v1.header.payload";

    expect(redact.text(`Authorization: Bearer ${jwt} apiKey=${capability}`)).toBe(
      "Authorization: Bearer <redacted> apiKey=<redacted>",
    );
  });

  test("detects signed capabilities without classifying ordinary version text", () => {
    expect(containsSignedCapability("v1.header.payload")).toBe(true);
    expect(containsSignedCapability("release v1.2.3")).toBe(false);
  });

  test("scrubs inline credentials that are not registered org secrets", () => {
    // Procedure traces record command lines - a literal credential in a command
    // is not a stored org secret, so exact-value redaction misses it.
    const redact = createSecretRedactor([]);
    expect(redact.text('curl -H "Authorization: Bearer sk-abc123DEF456ghi789JKL" api')).toContain(
      "<redacted>",
    );
    expect(redact.text('curl -H "Authorization: Bearer sk-abc123DEF456ghi789JKL" api')).not.toContain(
      "sk-abc123DEF456ghi789JKL",
    );
    expect(redact.text("psql PGPASSWORD=hunter2secret host")).toBe(
      "psql PGPASSWORD=<redacted> host",
    );
    expect(redact.text("export API_KEY=ZYXW9876abcd1234")).toBe("export API_KEY=<redacted>");
    expect(redact.text("token ghp_0123456789abcdefghijABCDEFG stored")).toBe(
      "token <redacted> stored",
    );
    expect(redact.text("mysql -phunter2secret db")).toBe("mysql -p<redacted> db");
    // A benign path with no credential shape is untouched.
    expect(redact.text("cd /root/work/upstream-org/backend && bun test")).toBe(
      "cd /root/work/upstream-org/backend && bun test",
    );
  });

  test("does not mutate the original native frame", () => {
    const original = { state: { output: "prefix super-secret-token-value suffix" } };
    const redact = createSecretRedactor(["super-secret-token-value"]);

    expect(redact.unknown(original)).toEqual({ state: { output: "prefix <redacted> suffix" } });
    expect(original.state.output).toBe("prefix super-secret-token-value suffix");
  });
});
