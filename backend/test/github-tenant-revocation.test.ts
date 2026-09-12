import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  resolveGithubRepositoryAccess,
  resolveGithubSandboxToken,
} from "../src/github/auth";
import { githubOrgAccessErrorForOrg, listRepos } from "../src/github/repos";
import { createIntegrationConnection } from "../src/integrations/connection-repo";
import { GITHUB_NATIVE_RUNTIME_BINDING_ID } from "../src/integrations/github-native-backend";
import { uid } from "./helpers";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const ENV_KEYS = [
  "GITHUB_CONNECTION_APP_ID",
  "GITHUB_CONNECTION_APP_SLUG",
  "GITHUB_CONNECTION_APP_PRIVATE_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_ORG",
  "GITHUB_TENANT_ORG_ID",
] as const;

beforeEach(() => {
  process.env.GITHUB_CONNECTION_APP_ID = "tenant-app";
  process.env.GITHUB_CONNECTION_APP_SLUG = "useagent-cloud";
  process.env.GITHUB_CONNECTION_APP_PRIVATE_KEY = PEM;
  process.env.GITHUB_APP_ID = "legacy-app";
  process.env.GITHUB_APP_PRIVATE_KEY = PEM;
  process.env.GITHUB_ORG = "legacy-owner";
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

async function createRevokedGithubConnection(orgId: string): Promise<void> {
  await createIntegrationConnection({
    orgId,
    owner: { type: "org" },
    provider: "github",
    runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID,
    externalConnectionId: uid("revoked-github-installation"),
    externalConnectionName: "acme",
    status: "revoked",
    authMethod: "custom_credential",
    account: { displayName: "acme" },
    scopes: ["contents:read", "metadata:read"],
    createdByUserId: uid("github-admin"),
  });
}

describe("revoked tenant GitHub integration", () => {
  test("repository catalog does not fall back to the deployment GitHub App", async () => {
    const orgId = uid("revoked-github-catalog-org");
    process.env.GITHUB_TENANT_ORG_ID = orgId;
    await createRevokedGithubConnection(orgId);
    await expect(githubOrgAccessErrorForOrg(orgId)).resolves.toBe(
      "GitHub integration has been revoked for this organization",
    );
    await expect(listRepos(orgId)).resolves.toEqual({
      configured: true,
      repos: [],
      error: "GitHub integration has been revoked for this organization",
    });
    await expect(resolveGithubRepositoryAccess(orgId)).rejects.toThrow(
      "GitHub integration has been revoked for this organization",
    );
  });

  test("sandbox repository access does not fall back to the deployment GitHub App", async () => {
    const orgId = uid("revoked-github-sandbox-org");
    process.env.GITHUB_TENANT_ORG_ID = orgId;
    await createRevokedGithubConnection(orgId);
    await expect(
      resolveGithubSandboxToken("acme/private-repo", orgId),
    ).rejects.toThrow("GitHub integration has been revoked for this organization");
  });
});
