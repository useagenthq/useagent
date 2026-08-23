import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GITHUB_NATIVE_RUNTIME_BINDING_ID,
  createGithubDelegatedConnectionBackend,
  createGithubNativeConnectionBackend,
} from "./github-native-backend";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installation(overrides: Record<string, unknown> = {}) {
  return {
    id: 901,
    app_id: 4_689_651,
    app_slug: "useagent-cloud",
    repository_selection: "selected",
    suspended_at: null,
    account: {
      id: 77,
      login: "acme-inc",
      avatar_url: "https://avatars.example/acme.png",
      type: "Organization",
    },
    permissions: {
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "read",
      administration: "none",
    },
    ...overrides,
  };
}

function backend(fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return createGithubNativeConnectionBackend(
    {
      appId: "4689651",
      appSlug: "useagent-cloud",
      privateKey: PRIVATE_KEY,
    },
    { fetch: fetchImpl, now: () => 1_787_480_000_000 },
  );
}

describe("GitHub native connection backend", () => {
  test("builds the public installation URL with opaque state", () => {
    const instance = backend(async () => response(500));
    expect(instance.buildInstallUrl({ state: "state/a+b" })).toBe(
      "https://github.com/apps/useagent-cloud/installations/new?state=state%2Fa%2Bb",
    );
  });

  test("validates the configured App identity with an App JWT", async () => {
    let authorization = "";
    const instance = backend(async (input, init) => {
      expect(String(input)).toBe("https://api.github.com/app");
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return response(200, { id: 4_689_651, slug: "useagent-cloud" });
    });

    await expect(instance.validateApp()).resolves.toEqual({
      appId: "4689651",
      appSlug: "useagent-cloud",
    });
    const [, encodedPayload] = authorization.replace(/^Bearer /u, "").split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as {
      iss: string;
      exp: number;
      iat: number;
    };
    expect(payload.iss).toBe("4689651");
    expect(payload.exp - payload.iat).toBe(600);
  });

  test("projects a validated installation without credential material", async () => {
    const instance = backend(async (input) => {
      expect(String(input)).toBe("https://api.github.com/app/installations/901");
      return response(200, installation());
    });

    await expect(instance.completeInstall(901)).resolves.toEqual({
      runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID,
      externalConnectionId: "901",
      externalConnectionName: "acme-inc",
      authMethod: "custom_credential",
      account: {
        externalAccountId: "77",
        displayName: "acme-inc",
        avatarUrl: "https://avatars.example/acme.png",
      },
      scopes: ["contents:read", "issues:read", "metadata:read", "pull_requests:read"],
    });
  });

  test("rejects an installation owned by another GitHub App", async () => {
    const instance = backend(async () => response(200, installation({ app_id: 123 })));
    await expect(instance.completeInstall(901)).rejects.toThrow(
      "does not belong to the configured App",
    );
  });

  test("rejects suspended installations", async () => {
    const instance = backend(async () =>
      response(200, installation({ suspended_at: "2026-08-23T00:00:00Z" })),
    );
    await expect(instance.completeInstall(901)).rejects.toThrow("installation is suspended");
  });

  test("rejects installations whose permissions exceed the read-only contract", async () => {
    const instance = backend(async () =>
      response(200, installation({ permissions: { contents: "write", metadata: "read" } })),
    );
    await expect(instance.completeInstall(901)).rejects.toThrow(
      "non-read-only permissions: contents:write",
    );
  });

  test("disconnect is idempotent when GitHub already removed the installation", async () => {
    const methods: string[] = [];
    const instance = backend(async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return response(404);
    });
    await expect(instance.disconnectInstallation(901)).resolves.toBeUndefined();
    expect(methods).toEqual(["DELETE"]);
  });

  test("disconnect requires GitHub to confirm deletion", async () => {
    const instance = backend(async () => response(403));
    await expect(instance.disconnectInstallation(901)).rejects.toThrow(
      "disconnect failed: HTTP 403",
    );
  });

  test("adapts installation callbacks to the shared delegated lifecycle", async () => {
    const delegated = createGithubDelegatedConnectionBackend(
      {
        appId: "4689651",
        appSlug: "useagent-cloud",
        privateKey: PRIVATE_KEY,
      },
      { fetch: async () => response(200, installation()), now: () => 1_787_480_000_000 },
    );
    const started = await delegated.startConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "github",
      state: "opaque-state",
    });
    expect(started.redirectUrl).toBe(
      "https://github.com/apps/useagent-cloud/installations/new?state=opaque-state",
    );
    await expect(
      delegated.completeConnect({
        orgId: "org-1",
        userId: "user-1",
        provider: "github",
        backendSessionRef: started.backendSessionRef,
        callback: { installation_id: "901", setup_action: "install" },
      }),
    ).resolves.toMatchObject({
      runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID,
      externalConnectionId: "901",
    });
  });
});
