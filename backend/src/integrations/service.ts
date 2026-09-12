import type {
  IntegrationActionCatalogEntry,
  IntegrationSummary,
} from "@useagent/agent-client/integrations";
import {
  claimIntegrationConnectSession,
  createIntegrationConnectState,
  createIntegrationConnectSession,
  finalizeIntegrationConnectSession,
  releaseIntegrationConnectSessionClaim,
  type IntegrationConnectSessionRecord,
} from "./connect-sessions";
import {
  INTEGRATION_CATALOG,
  integrationCatalogDefinition,
  isUserFacingIntegrationProvider,
  summarizeIntegrationPermissions,
} from "./catalog";
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

export interface ExecutableIntegrationAction {
  readonly connectionId: string;
  readonly entry: IntegrationActionCatalogEntry;
}

export interface IntegrationServiceDependencies {
  readonly managedBackends: readonly ManagedConnectionBackend[];
  readonly delegatedBackends: readonly DelegatedConnectionBackend[];
}

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

function ownerForRecord(record: { ownerType: "org" | "user"; ownerUserId: string | null }) {
  return record.ownerType === "org"
    ? ({ type: "org" } as const)
    : ({ type: "user", userId: record.ownerUserId! } as const);
}

function integrationBackend(provider: string): IntegrationSummary["backend"] {
  return provider === "github" || provider === "slack" ? "native" : "openconnector";
}

function connectionDegradationReason(status: IntegrationSummary["status"]): string | null {
  if (status === "connecting") return "Connection setup is still in progress.";
  if (status === "reauth_required") return "Reconnect to restore access.";
  if (status === "unhealthy") return "Connection health verification failed.";
  if (status === "revoked") return "Connection access has been revoked.";
  return null;
}

export function selectProviderConnection<T extends {
  readonly status: IntegrationSummary["status"];
  readonly ownerType: "org" | "user";
  readonly createdAt: Date;
}>(
  rows: readonly T[],
): T | null {
  const priority: Record<IntegrationSummary["status"], number> = {
    connected: 5,
    unhealthy: 4,
    reauth_required: 3,
    connecting: 2,
    revoked: 1,
    unavailable: 0,
  };
  return rows.reduce<T | null>((selected, row) => {
    if (!selected) return row;
    const status = priority[row.status] - priority[selected.status];
    if (status !== 0) return status > 0 ? row : selected;
    if (row.ownerType !== selected.ownerType) return row.ownerType === "user" ? row : selected;
    return row.createdAt > selected.createdAt ? row : selected;
  }, null);
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
      const [managed, connections, discoveries] = await Promise.all([
        Promise.all(deps.managedBackends.map((backend) => backend.readStatus(scope))),
        listVisibleIntegrationConnectionRecords(scope),
        Promise.all(
          deps.delegatedBackends.map(async (backend) => {
            try {
              return { backend, providers: await backend.listConnectableProviders(), failed: false };
            } catch {
              return { backend, providers: [] as readonly string[], failed: true };
            }
          }),
        ),
      ]);
      const managedByProvider = new Map(managed.map((status) => [status.provider, status]));
      const discoveredBackendByProvider = new Map<string, DelegatedConnectionBackend>();
      for (const discovery of discoveries) {
        for (const provider of discovery.providers) {
          if (isUserFacingIntegrationProvider(provider) && discovery.backend.supports(provider)) {
            discoveredBackendByProvider.set(provider, discovery.backend);
          }
        }
      }
      const connectionsByProvider = new Map<string, typeof connections>();
      for (const connection of connections) {
        const rows = connectionsByProvider.get(connection.provider) ?? [];
        connectionsByProvider.set(connection.provider, [...rows, connection]);
      }
      const providers = new Set<string>(INTEGRATION_CATALOG.map((entry) => entry.provider));
      for (const provider of managedByProvider.keys()) providers.add(provider);
      for (const provider of connectionsByProvider.keys()) providers.add(provider);
      for (const provider of discoveredBackendByProvider.keys()) providers.add(provider);
      const orderedProviders = [
        ...INTEGRATION_CATALOG.map((entry) => entry.provider),
        ...[...providers]
          .filter((provider) => !INTEGRATION_CATALOG.some((entry) => entry.provider === provider))
          .filter(isUserFacingIntegrationProvider)
          .sort(),
      ];

      return Promise.all(orderedProviders.map(async (provider): Promise<IntegrationSummary> => {
        const definition = integrationCatalogDefinition(provider);
        const record = selectProviderConnection(connectionsByProvider.get(provider) ?? []);
        if (record) {
          const backend = backendForBinding(record.runtimeBindingId);
          let actions: readonly IntegrationActionCatalogEntry[] = [];
          let actionCatalogUnavailable = false;
          if (record.status === "connected" && backend) {
            try {
              actions = await backend.listActions({ ...scope, connection: record });
            } catch {
              actionCatalogUnavailable = true;
            }
          }
          const connection = projectIntegrationConnection(record);
          return {
            ...definition,
            backend: backend?.catalogBackend ?? integrationBackend(provider),
            authMethod: record.authMethod,
            managed: false,
            configured: backend !== null,
            connectAvailable: discoveredBackendByProvider.has(provider),
            disconnectAvailable:
              record.status !== "revoked" && backend?.disconnectSupported === true,
            status: record.status,
            degradationReason:
              connectionDegradationReason(record.status) ??
              (!backend
                ? "The connector runtime for this connection is unavailable."
                : actionCatalogUnavailable
                  ? "Connected, but action permissions could not be verified."
                  : null),
            permissions: summarizeIntegrationPermissions({ scopes: connection.scopes, actions }),
            account: connection.account,
            connection,
          };
        }

        const managedStatus = managedByProvider.get(provider);
        if (managedStatus) {
          return {
            provider,
            displayName: managedStatus.label,
            description: managedStatus.description,
            backend: "native",
            authMethod: managedStatus.authMethod,
            managed: true,
            configured: managedStatus.configured,
            connectAvailable: false,
            disconnectAvailable: false,
            status: managedStatus.status,
            degradationReason: managedStatus.degradationReason ?? null,
            permissions: summarizeIntegrationPermissions({ scopes: managedStatus.scopes }),
            ...(managedStatus.account ? { account: managedStatus.account } : {}),
            connection: null,
          };
        }

        const backend = discoveredBackendByProvider.get(provider);
        const discoveryFailed = discoveries.some(
          (discovery) => discovery.failed && discovery.backend.supports(provider),
        );
        return {
          ...definition,
          backend: backend?.catalogBackend ?? integrationBackend(provider),
          authMethod: backend?.catalogAuthMethod ?? null,
          managed: false,
          configured: Boolean(backend),
          connectAvailable: Boolean(backend),
          disconnectAvailable: false,
          status: "unavailable",
          degradationReason: backend
            ? null
            : discoveryFailed
              ? "Connector availability could not be verified."
              : "Connector is not configured on this server.",
          permissions: summarizeIntegrationPermissions({}),
          connection: null,
        };
      }));
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
