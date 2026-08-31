import { describe, expect, test } from "bun:test";
import type { DelegatedConnectionBackend } from "../src/integrations/backend";
import {
  readIntegrationCredential,
  upsertIntegrationCredential,
} from "../src/integrations/credential-repo";
import {
  findVisibleIntegrationConnectionRecord,
  listVisibleIntegrationConnectionRecords,
} from "../src/integrations/connection-repo";
import { createIntegrationService } from "../src/integrations/service";
import { createIntegrationRoutes } from "../src/integrations/routes";
import {
  SLACK_NATIVE_RUNTIME_BINDING_ID,
  SLACK_OAUTH_CREDENTIAL_FORMAT,
} from "../src/integrations/slack-native-backend";
import { resolveSlackBotTokenForWorkspace } from "../src/integrations/slack-token-resolver";
import type { SlackConfig } from "../src/env";
import { findSlackUser, findSlackWorkspace } from "../src/slack/workspaces";
import { db } from "../src/db/client";
import { integrationConnectionCredentials } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { uid } from "./helpers";

describe("Slack integration credential persistence", () => {
  test("stores callback credentials atomically, isolates tenants, and deletes them on disconnect", async () => {
    const orgId = uid("slack-oauth-org");
    const userId = uid("slack-oauth-user");
    const teamId = uid("slack-team");
    let disconnected = false;
    const backend: DelegatedConnectionBackend = {
      kind: "delegated",
      runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
      disconnectSupported: true,
      supports: (provider) => provider === "slack",
      async listConnectableProviders() { return ["slack"]; },
      async startConnect(input) {
        return {
          backendSessionRef: input.state,
          runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
          redirectUrl: `https://slack.example/oauth?state=${input.state}`,
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
      async completeConnect() {
        return {
          runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
          externalConnectionId: teamId,
          externalConnectionName: "Acme",
          authMethod: "oauth2",
          account: { externalAccountId: teamId, displayName: "Acme" },
          scopes: ["bot:chat:write"],
          credential: {
            format: SLACK_OAUTH_CREDENTIAL_FORMAT,
            serialized: JSON.stringify({
              version: 1,
              provider: "slack",
              externalConnectionId: teamId,
              credential: {
                version: 1,
                bot: { accessToken: "xoxb-persistence-secret", tokenType: "bot" },
              },
            }),
          },
          workspaceBinding: {
            externalWorkspaceId: teamId,
            externalActorId: "U0INSTALLER",
          },
        };
      },
      async disconnect(input) {
        const material = await readIntegrationCredential({
          connectionId: input.connection.id,
          orgId: input.orgId,
          provider: "slack",
          externalConnectionId: teamId,
        });
        expect(material?.serialized).toContain("xoxb-persistence-secret");
        disconnected = true;
      },
      async listActions() { return []; },
      async executeAction() { throw new Error("not used"); },
    };
    const service = createIntegrationService({ managedBackends: [], delegatedBackends: [backend] });
    const started = await service.startConnect({
      orgId,
      userId,
      provider: "slack",
      returnTo: "/settings#integrations",
      owner: { type: "org" },
    });
    const connection = await service.completeConnect({
      orgId,
      userId,
      state: started.state,
      callback: { code: "temporary-code" },
    });
    expect(JSON.stringify(connection)).not.toContain("xoxb-persistence-secret");

    const record = await findVisibleIntegrationConnectionRecord({ orgId, userId, id: connection.id });
    expect(record).not.toBeNull();
    const identity = {
      connectionId: connection.id,
      orgId,
      provider: "slack",
      externalConnectionId: teamId,
    };
    await expect(readIntegrationCredential(identity)).resolves.toMatchObject({
      format: SLACK_OAUTH_CREDENTIAL_FORMAT,
    });
    const [storedCredential] = await db
      .select()
      .from(integrationConnectionCredentials)
      .where(eq(integrationConnectionCredentials.connectionId, connection.id));
    expect(JSON.stringify(storedCredential)).not.toContain("xoxb-persistence-secret");
    await expect(readIntegrationCredential({ ...identity, orgId: uid("other-org") }))
      .resolves.toBeNull();
    await expect(readIntegrationCredential({ ...identity, externalConnectionId: "T0OTHER" }))
      .resolves.toBeNull();
    const config: SlackConfig = {
      signingSecret: "signing-secret",
      apiUrl: "https://slack.example/api/",
      defaultEngine: "opencode",
      model: "model",
      channelAllowlist: new Set(),
      legacyBotToken: null,
      legacyTeamId: null,
    };
    await expect(resolveSlackBotTokenForWorkspace({ orgId, teamId, config }))
      .resolves.toBe("xoxb-persistence-secret");
    await expect(resolveSlackBotTokenForWorkspace({ orgId: uid("wrong-org"), teamId, config }))
      .resolves.toBeNull();
    await expect(findSlackWorkspace(teamId)).resolves.toEqual({ orgId, userId });
    await expect(findSlackUser(teamId, "U0INSTALLER")).resolves.toEqual({ orgId, userId });
    await expect(upsertIntegrationCredential(
      { ...identity, orgId: uid("wrong-org") },
      { format: SLACK_OAUTH_CREDENTIAL_FORMAT, serialized: "replacement" },
    )).rejects.toThrow("identity mismatch");

    await service.disconnect({
      orgId,
      userId,
      connectionId: connection.id,
      provider: "slack",
      allowOrgOwner: true,
    });
    expect(disconnected).toBe(true);
    await expect(readIntegrationCredential(identity)).resolves.toBeNull();
    await expect(findSlackWorkspace(teamId)).resolves.toBeNull();
    await expect(findSlackUser(teamId, "U0INSTALLER")).resolves.toBeNull();
  });

  test("public OAuth callback consumes state, binds the workspace, and redirects once", async () => {
    const orgId = uid("slack-route-org");
    const userId = uid("slack-route-user");
    const teamId = uid("slack-route-team");
    let callbackCode: string | undefined;
    const backend: DelegatedConnectionBackend = {
      kind: "delegated",
      runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
      disconnectSupported: true,
      supports: (provider) => provider === "slack",
      async listConnectableProviders() { return ["slack"]; },
      async startConnect(input) {
        return {
          backendSessionRef: input.state,
          runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
          redirectUrl: `https://slack.example/oauth?state=${input.state}`,
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
      async completeConnect(input) {
        callbackCode = input.callback?.code;
        return {
          runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
          externalConnectionId: teamId,
          externalConnectionName: "Route Workspace",
          authMethod: "oauth2",
          account: { externalAccountId: teamId, displayName: "Route Workspace" },
          scopes: ["bot:chat:write"],
          credential: {
            format: SLACK_OAUTH_CREDENTIAL_FORMAT,
            serialized: JSON.stringify({
              version: 1,
              provider: "slack",
              externalConnectionId: teamId,
              credential: {
                version: 1,
                bot: { accessToken: "xoxb-route-secret", tokenType: "bot" },
              },
            }),
          },
          workspaceBinding: {
            externalWorkspaceId: teamId,
            externalActorId: "U0ROUTE",
          },
        };
      },
      async disconnect() {},
      async listActions() { return []; },
      async executeAction() { throw new Error("not used"); },
    };
    const deps = { managedBackends: [], delegatedBackends: [backend] };
    const service = createIntegrationService(deps);
    const started = await service.startConnect({
      orgId,
      userId,
      provider: "slack",
      returnTo: "/settings?section=providers#integrations",
      owner: { type: "user", userId },
    });
    const routes = createIntegrationRoutes(deps);
    const response = await routes.request(
      `https://app.useagent.org/slack/callback?state=${encodeURIComponent(started.state)}&code=route-code`,
    );

    expect(response.status).toBe(303);
    const destination = new URL(response.headers.get("location") ?? "https://invalid");
    expect(destination.pathname).toBe("/settings");
    expect(destination.searchParams.get("section")).toBe("providers");
    expect(destination.searchParams.get("integration")).toBe("connected");
    expect(destination.searchParams.get("integration_provider")).toBe("slack");
    expect(destination.hash).toBe("#integrations");
    expect(callbackCode).toBe("route-code");
    expect(await listVisibleIntegrationConnectionRecords({ orgId, userId })).toHaveLength(1);
    expect(await findSlackWorkspace(teamId)).toEqual({ orgId, userId });
    expect(await findSlackUser(teamId, "U0ROUTE")).toEqual({ orgId, userId });

    const replay = await routes.request(
      `https://app.useagent.org/slack/callback?state=${encodeURIComponent(started.state)}&code=route-code`,
    );
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toContain("integration=error");
  });
});
