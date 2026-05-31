import { describe, expect, test } from "bun:test";
import type { IntegrationConnectionRecord } from "./connection-repo";
import {
  createSlackDelegatedConnectionBackend,
  decodeSlackStoredCredential,
  SLACK_NATIVE_RUNTIME_BINDING_ID,
  SLACK_OAUTH_CREDENTIAL_FORMAT,
} from "./slack-native-backend";
import type { SlackOAuthClient, SlackOAuthCredentialBundle } from "./slack-oauth-client";

const STATE = "6KKGnh9rjggpnoeUYZhiypQX3LfnSkWj9bpThtl2Z3c";
const CREDENTIAL: SlackOAuthCredentialBundle = {
  version: 1,
  bot: { accessToken: "xoxb-secret", tokenType: "bot" },
};

function connection(overrides: Partial<IntegrationConnectionRecord> = {}): IntegrationConnectionRecord {
  return {
    id: "1aa6fe71-3d05-4b7b-b72c-eeb762923705",
    orgId: "org-1",
    ownerType: "org",
    ownerUserId: null,
    provider: "slack",
    runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
    externalConnectionId: "T0TEAM",
    externalConnectionName: "Acme",
    status: "connected",
    authMethod: "oauth2",
    accountMetadata: { externalAccountId: "T0TEAM", displayName: "Acme" },
    scopes: ["bot:chat:write"],
    createdByUserId: "user-1",
    lastVerifiedAt: new Date(),
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeClient(overrides: Partial<SlackOAuthClient> = {}): SlackOAuthClient {
  return {
    buildAuthorizeUrl: ({ state }) => `https://slack.example/oauth?state=${state}`,
    exchangeCode: async () => ({
      credential: CREDENTIAL,
      projection: {
        externalConnectionId: "T0TEAM",
        externalConnectionName: "Acme",
        account: { externalAccountId: "T0TEAM", displayName: "Acme" },
        scopes: ["bot:chat:write"],
        metadata: {
          appId: "A0APP",
          botUserId: "U0BOT",
          isEnterpriseInstall: false,
          workspace: { id: "T0TEAM", name: "Acme" },
        },
      },
    }),
    completeCallback: async () => { throw new Error("not used"); },
    revokeToken: async () => {},
    revokeCredential: async () => {},
    ...overrides,
  };
}

const config = {
  appId: "A0APP",
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://useagent.example/api/integrations/callback/slack",
  botScopes: ["chat:write"],
  userScopes: [],
};

describe("Slack native delegated backend", () => {
  test("returns only safe projection fields while carrying sealed-storage material server-side", async () => {
    const backend = createSlackDelegatedConnectionBackend(config, {
      client: fakeClient(),
      now: () => 1_000,
    });
    const started = await backend.startConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "slack",
      state: STATE,
    });
    expect(started).toEqual({
      backendSessionRef: STATE,
      runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
      redirectUrl: `https://slack.example/oauth?state=${STATE}`,
      expiresAt: new Date(601_000),
    });

    const result = await backend.completeConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "slack",
      backendSessionRef: STATE,
      callback: { code: "temporary-code" },
    });
    expect(result).toMatchObject({
      runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
      externalConnectionId: "T0TEAM",
      externalConnectionName: "Acme",
      authMethod: "oauth2",
      account: { externalAccountId: "T0TEAM", displayName: "Acme" },
      scopes: ["bot:chat:write"],
      credential: { format: SLACK_OAUTH_CREDENTIAL_FORMAT },
      workspaceBinding: {
        externalWorkspaceId: "T0TEAM",
      },
    });
    expect(JSON.stringify({ ...result, credential: undefined })).not.toContain("xoxb-secret");
    expect(
      decodeSlackStoredCredential(result.credential!.serialized, "T0TEAM"),
    ).toEqual(CREDENTIAL);
    expect(() => decodeSlackStoredCredential(result.credential!.serialized, "T0OTHER"))
      .toThrow("credential is invalid");
  });

  test("disconnect reads the exact tenant-bound credential and revokes it", async () => {
    const reads: unknown[] = [];
    const revoked: SlackOAuthCredentialBundle[] = [];
    const backend = createSlackDelegatedConnectionBackend(config, {
      client: fakeClient({ revokeCredential: async (credential) => { revoked.push(credential); } }),
      readCredential: async (identity) => {
        reads.push(identity);
        return {
          format: SLACK_OAUTH_CREDENTIAL_FORMAT,
          serialized: JSON.stringify({
            version: 1,
            provider: "slack",
            externalConnectionId: "T0TEAM",
            credential: CREDENTIAL,
          }),
        };
      },
    });
    await backend.disconnect({ orgId: "org-1", userId: "user-1", connection: connection() });
    expect(reads).toEqual([{
      connectionId: "1aa6fe71-3d05-4b7b-b72c-eeb762923705",
      orgId: "org-1",
      provider: "slack",
      externalConnectionId: "T0TEAM",
    }]);
    expect(revoked).toEqual([CREDENTIAL]);
  });

  test("sanitizes provider callback errors", async () => {
    const backend = createSlackDelegatedConnectionBackend(config, { client: fakeClient() });
    await expect(backend.completeConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "slack",
      backendSessionRef: STATE,
      callback: { error: "bad error with xoxb-secret" },
    })).rejects.toThrow("Slack authorization failed: unknown_error");
  });
});
