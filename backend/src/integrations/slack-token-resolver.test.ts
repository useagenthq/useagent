import { describe, expect, test } from "bun:test";
import type { SlackConfig } from "../env";
import type { IntegrationConnectionRecord } from "./connection-repo";
import { resolveSlackBotTokenForWorkspace } from "./slack-token-resolver";

const CONFIG: SlackConfig = {
  signingSecret: "signing-secret",
  apiUrl: "https://slack.example/api/",
  defaultEngine: "opencode",
  model: "model",
  channelAllowlist: new Set(),
  legacyBotToken: "xoxb-legacy",
  legacyTeamId: "T0LEGACY",
};

const CONNECTION = {
  id: "8f8426fc-847e-4b1c-bba0-7fd68cb66ab4",
  orgId: "org-1",
  ownerType: "org",
  ownerUserId: null,
  provider: "slack",
  runtimeBindingId: "native:slack-oauth",
  externalConnectionId: "T0OAUTH",
  externalConnectionName: "Acme",
  status: "connected",
  authMethod: "oauth2",
  accountMetadata: {},
  scopes: [],
  createdByUserId: "user-1",
  lastVerifiedAt: null,
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies IntegrationConnectionRecord;

describe("Slack workspace token resolver", () => {
  test("resolves only the exact org and team OAuth connection", async () => {
    const lookups: unknown[] = [];
    const token = await resolveSlackBotTokenForWorkspace(
      { orgId: "org-1", teamId: "T0OAUTH", config: CONFIG },
      {
        findConnection: async (input) => {
          lookups.push(input);
          return CONNECTION;
        },
        readCredential: async (connection) => {
          expect(connection).toBe(CONNECTION);
          return { version: 1, bot: { accessToken: "xoxb-oauth", tokenType: "bot" } };
        },
      },
    );
    expect(token).toBe("xoxb-oauth");
    expect(lookups).toEqual([{
      orgId: "org-1",
      provider: "slack",
      runtimeBindingId: "native:slack-oauth",
      externalConnectionId: "T0OAUTH",
    }]);
  });

  test("uses the global token only for the explicitly named legacy workspace", async () => {
    const deps = { findConnection: async () => null, readCredential: async () => null };
    await expect(resolveSlackBotTokenForWorkspace(
      { orgId: "org-1", teamId: "T0LEGACY", config: CONFIG },
      deps,
    )).resolves.toBe("xoxb-legacy");
    await expect(resolveSlackBotTokenForWorkspace(
      { orgId: "org-1", teamId: "T0OTHER", config: CONFIG },
      deps,
    )).resolves.toBeNull();
  });

  test("fails closed when a connection exists without credential material", async () => {
    await expect(resolveSlackBotTokenForWorkspace(
      { orgId: "org-1", teamId: "T0OAUTH", config: CONFIG },
      { findConnection: async () => CONNECTION, readCredential: async () => null },
    )).resolves.toBeNull();
  });
});
