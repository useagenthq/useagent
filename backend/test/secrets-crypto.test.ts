import { describe, expect, test } from "bun:test";
import {
  isValidSecretName,
  openSecret,
  rewrapSecret,
  sealSecret,
  secretNeedsRewrap,
  type SealedSecret,
} from "../src/secrets/crypto";

// Pure crypto + name-validation unit tests (no DB). Covers the round-trip, that a
// tamper of ANY sealed field fails closed (throws, never returns forged
// plaintext), and the env-var-name grammar.

/** Flip the first byte of a base64 field so it is guaranteed different. */
function flipByte(b64: string): string {
  const prefix = b64.startsWith("v2:") ? b64.slice(0, b64.indexOf(":", 3) + 1) : "";
  const payload = prefix ? b64.slice(prefix.length) : b64;
  const buf = Buffer.from(payload, "base64");
  buf[0] = buf[0]! ^ 0xff;
  return `${prefix}${buf.toString("base64")}`;
}

describe("secrets crypto — AES-256-GCM round-trip", () => {
  test("encrypt → decrypt returns the original plaintext", () => {
    for (const plain of ["hunter2", "", "a".repeat(4096), "gcp-sa-key\n{json}", "🔐 unicode"]) {
      const sealed = sealSecret(plain);
      expect(openSecret(sealed)).toBe(plain);
    }
  });

  test("the same plaintext encrypts to different ciphertext each time (random iv)", () => {
    const a = sealSecret("same-value");
    const b = sealSecret("same-value");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // ...yet both decrypt back to the same plaintext.
    expect(openSecret(a)).toBe("same-value");
    expect(openSecret(b)).toBe("same-value");
  });
});

describe("secrets crypto — tamper fails closed", () => {
  const base = (): SealedSecret => sealSecret("top-secret-value");

  test("a tampered auth tag throws (never returns plaintext)", () => {
    const s = base();
    expect(() => openSecret({ ...s, tag: flipByte(s.tag) })).toThrow();
  });

  test("a tampered ciphertext throws", () => {
    const s = base();
    expect(() => openSecret({ ...s, ciphertext: flipByte(s.ciphertext) })).toThrow();
  });

  test("a tampered iv throws", () => {
    const s = base();
    expect(() => openSecret({ ...s, iv: flipByte(s.iv) })).toThrow();
  });

  test("garbage fields throw rather than decode to something", () => {
    expect(() => openSecret({ ciphertext: "!!!", iv: "!!!", tag: "!!!" })).toThrow();
  });
});

describe("secrets crypto — dedicated key rotation", () => {
  test("previous keys keep old rows readable until they are rewrapped", () => {
    const previousCurrent = process.env.SECRETS_ENCRYPTION_KEY;
    const previousKeyring = process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS;
    const oldKey = "old-encryption-root-0123456789abcdef0123456789";
    const newKey = "new-encryption-root-0123456789abcdef0123456789";
    try {
      process.env.SECRETS_ENCRYPTION_KEY = oldKey;
      delete process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS;
      const oldSealed = sealSecret("rotation-proof");

      process.env.SECRETS_ENCRYPTION_KEY = newKey;
      process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS = JSON.stringify([oldKey]);
      expect(openSecret(oldSealed)).toBe("rotation-proof");
      expect(secretNeedsRewrap(oldSealed)).toBe(true);

      const rewrapped = rewrapSecret(oldSealed);
      expect(secretNeedsRewrap(rewrapped)).toBe(false);
      delete process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS;
      expect(openSecret(rewrapped)).toBe("rotation-proof");
      expect(() => openSecret(oldSealed)).toThrow(/no configured secret encryption key matches/);
    } finally {
      if (previousCurrent === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
      else process.env.SECRETS_ENCRYPTION_KEY = previousCurrent;
      if (previousKeyring === undefined) delete process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS;
      else process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS = previousKeyring;
    }
  });

  test("unversioned historical ciphertext remains readable and requires rewrap", () => {
    const current = sealSecret("legacy-row");
    const legacy = { ...current, ciphertext: current.ciphertext.split(":", 3)[2]! };
    expect(openSecret(legacy)).toBe("legacy-row");
    expect(secretNeedsRewrap(legacy)).toBe(true);
  });

  test("rejects malformed previous-key configuration", () => {
    const previous = process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS;
    try {
      process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS = "not-json";
      expect(() => openSecret(sealSecret("x"))).toThrow(/must be a JSON string array/);
    } finally {
      if (previous === undefined) delete process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS;
      else process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS = previous;
    }
  });
});

describe("secrets crypto — name validation (^[A-Z][A-Z0-9_]*$)", () => {
  test("accepts env-var identifiers", () => {
    for (const name of ["A", "ABC", "AWS_SECRET_ACCESS_KEY", "GCP_SA_KEY", "A1", "A_1_B", "X9_Y"]) {
      expect(isValidSecretName(name)).toBe(true);
    }
  });

  test("rejects anything that is not an env-var identifier", () => {
    for (const name of ["", "1ABC", "_ABC", "aBC", "abc", "A-B", "A B", "AB.C", "AB=C", "A\nB", "Ünïcode"]) {
      expect(isValidSecretName(name)).toBe(false);
    }
  });
});
