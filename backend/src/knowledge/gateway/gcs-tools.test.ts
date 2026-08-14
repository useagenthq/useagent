import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createServiceAccountAssertion, executeGcsTool } from "./gcs-tools";
import type { ToolTokenClaims } from "./token";

const claims: ToolTokenClaims = {
  orgId: "org-1",
  userId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  scope: "run",
  exp: Date.now() + 60_000,
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const serviceAccount = {
  type: "service_account",
  project_id: "acme-test",
  private_key: privateKeyPem,
  client_email: "skynet@acme-test.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

describe("GCS gateway tool", () => {
  test("creates a verifiable, one-hour read-only service-account assertion", () => {
    const assertion = createServiceAccountAssertion(serviceAccount, 1_800_000_000_000);
    const [header, payload, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toMatchObject({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/devstorage.read_only",
      aud: "https://oauth2.googleapis.com/token",
      exp: 1_800_003_600,
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
  });

  test("lists buckets through fixed Google endpoints without exposing the credential", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await executeGcsTool(claims, "gcs_list_buckets", { max_results: 10 }, {
      decryptSecret: async (_orgId, name) =>
        name === "GCP_SERVICE_ACCOUNT_KEY"
          ? { name, kind: "file", value: JSON.stringify(serviceAccount) }
          : null,
      now: () => 1_800_000_000_000,
      fetchGoogle: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "access-token", token_type: "Bearer" });
        }
        return Response.json({ items: [{ name: "acme-a" }, { name: "acme-b" }] });
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      projectId: "acme-test",
      buckets: ["acme-a", "acme-b"],
      count: 2,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toStartWith(
      "https://storage.googleapis.com/storage/v1/b?project=acme-test",
    );
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe(
      "Bearer access-token",
    );
    expect(JSON.stringify(requests)).not.toContain(privateKeyPem);
  });

  test("rejects alternate token endpoints before any network request", async () => {
    let called = false;
    const result = await executeGcsTool(claims, "gcs_list_buckets", {}, {
      decryptSecret: async (_orgId, name) => ({
        name,
        kind: "file",
        value: JSON.stringify({ ...serviceAccount, token_uri: "https://attacker.test/token" }),
      }),
      fetchGoogle: async () => {
        called = true;
        return Response.json({});
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("token endpoint is not allowed");
    expect(called).toBe(false);
  });
});
