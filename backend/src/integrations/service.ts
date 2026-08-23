import type {
  ConnectionProjection,
  IntegrationActionCatalogEntry,
} from "@skynet/agent-client/integrations";
import {
  claimIntegrationConnectSession,
  createIntegrationConnectState,
  createIntegrationConnectSession,
  finalizeIntegrationConnectSession,
  releaseIntegrationConnectSessionClaim,
  type IntegrationConnectSessionRecord,
} from "./connect-sessions";
import {
  findVisibleIntegrationConnectionRecord,
  listVisibleIntegrationConnectionRecords,
  listVisibleIntegrationConnections,
  projectIntegrationConnection,
  revokeOwnedIntegrationConnection,
} from "./connection-repo";
import type {
  DelegatedConnectionBackend,
  IntegrationActorScope,
  IntegrationConnectCallback,
  ManagedConnectionBackend,
} from "./backend";
import { managedConnectionBackends } from "./managed-backends";
import {
  createGithubDelegatedConnectionBackend,
  githubNativeConnectionConfigFromEnv,
} from "./github-native-backend";
import {
  createOomolProjectConnectorBackend,
  oomolProjectConnectorConfigFromEnv,
} from "./oomol-project-connector";
import { createOpenConnectorBackend, openConnectorConfigFromEnv } from "./open-connector";
import {
  createSlackDelegatedConnectionBackend,
  slackNativeConnectionConfigFromEnv,
} from "./slack-native-backend";
import { publishOrgChange } from "../runs/org-signals";

export interface IntegrationSummary {
  readonly provider: string;
  readonly displayName: string;
  readonly description: string;
  readonly backend: "native" | "openconnector" | "mcp";
  readonly managed: boolean;
  readonly connectAvailable: boolean;
  readonly disconnectAvailable: boolean;
  readonly status: "connected" | "unavailable" | ConnectionProjection["status"];
  readonly account?: ConnectionProjection["account"];
  readonly connection: ConnectionProjection | null;
}

export interface ExecutableIntegrationAction {
  readonly connectionId: string;
  readonly entry: IntegrationActionCatalogEntry;
}

export interface IntegrationServiceDependencies {
  readonly managedBackends: readonly ManagedConnectionBackend[];
  readonly delegatedBackends: readonly DelegatedConnectionBackend[];
}

const DELEGATED_INTEGRATION_CATALOG = [
  {
    provider: "github",
    displayName: "GitHub",
    description: "Native repository discovery, cloning, and pull request workflows.",
  },
  {
    provider: "slack",
    displayName: "Slack",
    description: "Native events, threads, files, and streaming cards.",
  },
  {
    provider: "linear",
    displayName: "Linear",
    description: "Issues, projects, and team workflows.",
  },
  { provider: "gmail", displayName: "Gmail", description: "Read, draft, and send email." },
  { provider: "notion", displayName: "Notion", description: "Pages, databases, and workspace content." },
  { provider: "hubspot", displayName: "HubSpot", description: "CRM contacts, companies, and deals." },
] as const;

function defaultDependencies(): IntegrationServiceDependencies {
  const openConnector = openConnectorConfigFromEnv();
  const oomol = oomolProjectConnectorConfigFromEnv();
  const github = githubNativeConnectionConfigFromEnv();
  const slack = slackNativeConnectionConfigFromEnv();
  return {
    managedBackends: managedConnectionBackends.filter(
      (backend) => !(github && backend.provider === "github") && !(slack && backend.provider === "slack"),
    ),
    delegatedBackends: [
      ...(github ? [createGithubDelegatedConnectionBackend(github)] : []),
      ...(slack ? [createSlackDelegatedConnectionBackend(slack)] : []),
      ...(oomol ? [createOomolProjectConnectorBackend(oomol)] : []),
      ...(openConnector ? [createOpenConnectorBackend(openConnector)] : []),
    ],
  };
}

function displayName(provider: string): string {
  return provider
    .split(/[\/_-]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function ownerForRecord(record: { ownerType: "org" | "user"; ownerUserId: string | null }) {
  return record.ownerType === "org"
    ? ({ type: "org" } as const)
    : ({ type: "user", userId: record.ownerUserId! } as const);
}

function integrationBackend(provider: string): IntegrationSummary["backend"] {
  return provider === "github" || provider === "slack" ? "native" : "openconnector";
}

export function createIntegrationService(
  deps: IntegrationServiceDependencies = defaultDependencies(),
) {
  function backendForNewConnect(provider: string): DelegatedConnectionBackend | null {
    return deps.delegatedBackends.find((backend) => backend.supports(provider)) ?? null;
  }

  function backendForBinding(runtimeBindingId: string): DelegatedConnectionBackend | null {
    return deps.delegatedBackends.find(
      (backend) => backend.runtimeBindingId === runtimeBindingId,
    ) ?? null;
  }

  async function completeClaimedConnect(input: {
    readonly state: string;
    readonly claimToken: string;
    readonly session: IntegrationConnectSessionRecord;
    readonly callback?: IntegrationConnectCallback;
  }) {
    const backend = backendForBinding(input.session.runtimeBindingId);
    if (!backend) throw new Error("integration backend is unavailable");
    try {
      const result = await backend.completeConnect({
        orgId: input.session.orgId,
        userId: input.session.actorUserId,
        provider: input.session.provider,
        backendSessionRef: input.session.backendSessionRef,
        callback: input.callback,
      });
      const connection = await finalizeIntegrationConnectSession({
        orgId: input.session.orgId,
        actorUserId: input.session.actorUserId,
        state: input.state,
        claimToken: input.claimToken,
        result,
      });
      if (!connection) throw new Error("integration connect session was already consumed");
      publishOrgChange(input.session.orgId, {
        type: "integration_connection",
        action: "created",
        connectionId: connection.id,
        provider: connection.provider,
        ...(connection.owner.type === "user"
          ? { targetUserId: connection.owner.userId }
          : {}),
      });
      return connection;
    } catch (error) {
      await releaseIntegrationConnectSessionClaim({
        sessionId: input.session.id,
        claimToken: input.claimToken,
      });
      throw error;
    }
  }

  return {
    async listIntegrations(scope: IntegrationActorScope): Promise<IntegrationSummary[]> {
      const [managed, connections, connectableProviders] = await Promise.all([
        Promise.all(deps.managedBackends.map((backend) => backend.readStatus(scope))),
        listVisibleIntegrationConnectionRecords(scope),
        Promise.all(
          deps.delegatedBackends.map((backend) =>
            backend.listConnectableProviders().catch(() => []),
          ),
        ).then((providers) => new Set(providers.flat())),
      ]);
      const connectionProviders = new Set(connections.map((connection) => connection.provider));
      const availableDelegated = DELEGATED_INTEGRATION_CATALOG.filter(
        (item) => !connectionProviders.has(item.provider) && backendForNewConnect(item.provider),
      );
      return [
        ...managed.map((status): IntegrationSummary => ({
          provider: status.provider,
          displayName: status.label,
          description: status.description,
          backend: "native",
          managed: true,
          connectAvailable: false,
          disconnectAvailable: false,
          status: status.status,
          ...(status.account ? { account: status.account } : {}),
          connection: null,
        })),
        ...availableDelegated.map((item): IntegrationSummary => ({
          provider: item.provider,
          displayName: item.displayName,
          description: item.description,
          backend: integrationBackend(item.provider),
          managed: false,
          connectAvailable: connectableProviders.has(item.provider),
          disconnectAvailable: false,
          status: "unavailable",
          connection: null,
        })),
        ...connections.map((record): IntegrationSummary => ({
          provider: record.provider,
          displayName: displayName(record.provider),
          description: `${displayName(record.provider)} account connection.`,
          backend: integrationBackend(record.provider),
          managed: false,
          connectAvailable: backendForNewConnect(record.provider) !== null,
          disconnectAvailable:
            record.status !== "revoked" &&
            backendForBinding(record.runtimeBindingId)?.disconnectSupported === true,
          status: record.status,
          account: projectIntegrationConnection(record).account,
          connection: projectIntegrationConnection(record),
        })),
      ];
    },

    async startConnect(input: IntegrationActorScope & {
      readonly provider: string;
      readonly returnTo: string;
      readonly owner:
        | { readonly type: "org" }
        | { readonly type: "user"; readonly userId: string };
    }) {
      const backend = backendForNewConnect(input.provider);
      if (!backend) throw new Error("integration provider is not connectable");
      const connectable = await backend.listConnectableProviders();
      if (!connectable.includes(input.provider)) {
        throw new Error("integration provider OAuth is not configured");
      }
      const state = createIntegrationConnectState();
      const started = await backend.startConnect({ ...input, state });
      const session = await createIntegrationConnectSession({
        orgId: input.orgId,
        actorUserId: input.userId,
        owner: input.owner,
        provider: input.provider,
        runtimeBindingId: started.runtimeBindingId,
        backendSessionRef: started.backendSessionRef,
        returnTo: input.returnTo,
        expiresAt: started.expiresAt,
        state,
      });
      return {
        redirectUrl: started.redirectUrl,
        state: session.state,
        expiresAt: session.expiresAt.toISOString(),
      };
    },

    async completeConnect(input: IntegrationActorScope & {
      readonly state: string;
      readonly callback?: IntegrationConnectCallback;
    }) {
      const claimed = await claimIntegrationConnectSession({
        orgId: input.orgId,
        actorUserId: input.userId,
        state: input.state,
      });
      if (!claimed) throw new Error("integration connect session is invalid, busy, or expired");
      return completeClaimedConnect({
        state: input.state,
        claimToken: claimed.claimToken,
        session: claimed.session,
        callback: input.callback,
      });
    },

    async completePublicCallback(input: {
      readonly provider: string;
      readonly state: string;
      readonly callback: IntegrationConnectCallback;
    }) {
      const claimed = await claimIntegrationConnectSession({ state: input.state });
      if (!claimed) throw new Error("integration connect session is invalid, busy, or expired");
      if (claimed.session.provider !== input.provider) {
        await releaseIntegrationConnectSessionClaim({
          sessionId: claimed.session.id,
          claimToken: claimed.claimToken,
        });
        throw new Error("integration provider mismatch");
      }
      const connection = await completeClaimedConnect({
        state: input.state,
        claimToken: claimed.claimToken,
        session: claimed.session,
        callback: input.callback,
      });
      return { connection, returnTo: claimed.session.returnTo };
    },

    async disconnect(input: IntegrationActorScope & {
      readonly connectionId: string;
      readonly provider?: string;
      readonly allowOrgOwner?: boolean;
    }) {
      const record = await findVisibleIntegrationConnectionRecord({
        ...input,
        id: input.connectionId,
      });
      if (!record) throw new Error("integration connection not found");
      if (input.provider && record.provider !== input.provider) {
        throw new Error("integration provider mismatch");
      }
      if (record.ownerType === "org" && !input.allowOrgOwner) {
        throw new Error("organization admin route required");
      }
      const backend = backendForBinding(record.runtimeBindingId);
      if (!backend) {
        throw new Error("integration backend is unavailable");
      }
      await backend.disconnect({ ...input, connection: record });
      const owner = ownerForRecord(record);
      const connection = await revokeOwnedIntegrationConnection({
        orgId: input.orgId,
        owner,
        id: record.id,
        account: record.accountMetadata,
        scopes: record.scopes,
        externalConnectionName: record.externalConnectionName,
        lastVerifiedAt: record.lastVerifiedAt,
      });
      if (!connection) throw new Error("integration connection not found");
      publishOrgChange(input.orgId, {
        type: "integration_connection",
        action: "revoked",
        connectionId: connection.id,
        provider: connection.provider,
        ...(connection.owner.type === "user" ? { targetUserId: connection.owner.userId } : {}),
      });
      return connection;
    },

    async listExecutableIntegrationActions(
      scope: IntegrationActorScope,
    ): Promise<ExecutableIntegrationAction[]> {
      const connections = await listVisibleIntegrationConnections(scope);
      const connected = connections.filter((connection) => connection.status === "connected");
      const rows = await Promise.all(
        connected.map(async (connection) => {
          const record = await findVisibleIntegrationConnectionRecord({
            ...scope,
            id: connection.id,
          });
          if (!record) return [];
          const backend = backendForBinding(record.runtimeBindingId);
          if (!backend) return [];
          const actions = await backend.listActions({ ...scope, connection: record });
          return actions.map((entry) => ({ connectionId: connection.id, entry }));
        }),
      );
      return rows.flat();
    },

    async executeIntegrationAction(input: IntegrationActorScope & {
      readonly connectionId: string;
      readonly actionId: string;
      readonly input: unknown;
      readonly idempotencyKey?: string;
      readonly approvalGranted: boolean;
    }): Promise<unknown> {
      const record = await findVisibleIntegrationConnectionRecord({
        ...input,
        id: input.connectionId,
      });
      if (!record || record.status !== "connected") {
        throw new Error("integration connection is not connected");
      }
      const backend = backendForBinding(record.runtimeBindingId);
      if (!backend) {
        throw new Error("integration backend is unavailable");
      }
      const actions = await backend.listActions({ ...input, connection: record });
      const action = actions.find((entry) => entry.actionId === input.actionId);
      if (!action) {
        throw new Error("integration action is not available for this connection");
      }
      if (action.approval === "disabled") {
        throw new Error("integration action is disabled by local policy");
      }
      if (action.approval === "interactive" && !input.approvalGranted) {
        throw new Error("integration action requires an approval lane");
      }
      const result = await backend.executeAction({ ...input, connection: record });
      const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      if (bytes > action.maxResultBytes) {
        throw new Error("integration action result exceeds its size limit");
      }
      return result;
    },
  };
}

export const integrationService = createIntegrationService();
export const listExecutableIntegrationActions =
  integrationService.listExecutableIntegrationActions;
export const executeIntegrationAction = integrationService.executeIntegrationAction;
