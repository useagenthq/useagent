import { describe, expect, test } from "bun:test";
import { createSecretRedactor } from "./redact";

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

  test("redacts signed capability tokens even when no org secret is present", () => {
    const redact = createSecretRedactor([]);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJydW5JZCI6InIxIn0.signaturebytes";
    const capability = "v1.header.payload";

    expect(redact.text(`Authorization: Bearer ${jwt} apiKey=${capability}`)).toBe(
      "Authorization: Bearer <redacted> apiKey=<redacted>",
    );
  });

  test("does not mutate the original native frame", () => {
    const original = { state: { output: "prefix super-secret-token-value suffix" } };
    const redact = createSecretRedactor(["super-secret-token-value"]);

    expect(redact.unknown(original)).toEqual({ state: { output: "prefix <redacted> suffix" } });
    expect(original.state.output).toBe("prefix super-secret-token-value suffix");
  });
});
