import { describe, expect, test } from "bun:test";
import { isValidSecretName } from "../src/secrets/crypto";
import { classifyKind, normalizeName, parseEnv, parseJson, parseText } from "../src/secrets/seed-parse";

// Pure seed-parsing + kind-classification tests (no DB). Mirrors the shapes the
// real seed sources use (an env-format .env and a JSON `application_secrets`).

describe("seed-parse — env format", () => {
  test("parses KEY=VALUE, handles export + quotes, skips comments/blanks, reports malformed lines", () => {
    const text = [
      "# a comment",
      "",
      "STRIPE_API_KEY=sk_live_abc",
      'export SENDGRID_API_KEY="SG.xyz"',
      "  DATADOG_API_KEY = dd-123  ",
      "not-a-kv-line", // malformed → line 6
      "gcloud.project=loop-core", // normalized name
    ].join("\n");
    const r = parseEnv(text);
    expect(r.format).toBe("env");
    expect(r.malformed).toEqual([6]);
    const byName = Object.fromEntries(r.entries.map((e) => [e.name, e.value]));
    expect(byName.STRIPE_API_KEY).toBe("sk_live_abc");
    expect(byName.SENDGRID_API_KEY).toBe("SG.xyz"); // quotes stripped
    expect(byName.DATADOG_API_KEY).toBe("dd-123"); // trimmed
    // lowercase + dot → UPPER_SNAKE
    expect(r.entries.some((e) => e.name === "GCLOUD_PROJECT")).toBe(true);
  });
});

describe("seed-parse — JSON format", () => {
  test("reads application_secrets; object values become file-kind", () => {
    const text = JSON.stringify({
      application_secrets: {
        EXAMPLE_API_KEY: "dvn-123",
        CLICKHOUSE_KEY_ID: "ch-id",
        GCP_SERVICE_ACCOUNT_KEY: { type: "service_account", project_id: "p" },
      },
      other: "ignored-sibling",
    });
    const r = parseJson(text);
    expect(r.format).toBe("json");
    const gac = r.entries.find((e) => e.name === "GCP_SERVICE_ACCOUNT_KEY");
    expect(gac?.forceFile).toBe(true);
    expect(gac?.value).toContain("service_account"); // stringified JSON
    expect(r.entries.find((e) => e.name === "EXAMPLE_API_KEY")?.forceFile).toBe(false);
    // The `other` sibling of application_secrets is NOT treated as a secret.
    expect(r.entries.some((e) => e.name === "OTHER")).toBe(false);
  });

  test("a flat object (no application_secrets wrapper) is used directly", () => {
    const r = parseJson(JSON.stringify({ LINEAR_API_KEY: "lin_1", POSTHOG_KEY: "ph_1" }));
    expect(r.entries.map((e) => e.name).sort()).toEqual(["LINEAR_API_KEY", "POSTHOG_KEY"]);
  });
});

describe("seed-parse — kind classification (by value shape)", () => {
  test("plain strings are env; JSON/PEM/base64 blobs are file", () => {
    expect(classifyKind("sk_live_abc", false)).toBe("env");
    expect(classifyKind("short", false)).toBe("env");
    expect(classifyKind('{"type":"service_account"}', false)).toBe("file");
    expect(classifyKind("-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----", false)).toBe("file");
    expect(classifyKind("A".repeat(200), false)).toBe("file"); // long base64-ish blob
    expect(classifyKind("anything", true)).toBe("file"); // forceFile wins
  });
});

describe("seed-parse — name normalization", () => {
  test("maps to UPPER_SNAKE; a leading digit stays invalid", () => {
    expect(normalizeName("gmail_support")).toBe("GMAIL_SUPPORT");
    expect(normalizeName("pg.loop-core")).toBe("PG_LOOP_CORE");
    expect(isValidSecretName(normalizeName("gmail_support"))).toBe(true);
    // A key that starts with a digit normalizes to an INVALID name (caller skips + reports).
    expect(isValidSecretName(normalizeName("1password"))).toBe(false);
  });
});

describe("seed-parse — parseText dispatch", () => {
  test("routes a leading-brace body to JSON and a KEY=VALUE body to env", () => {
    expect(parseText('{"A_KEY":"v"}', false).format).toBe("json");
    expect(parseText("A_KEY=v", false).format).toBe("env");
    // A .json hint that fails to parse falls back to env.
    expect(parseText("A_KEY=v", true).format).toBe("env");
  });
});
