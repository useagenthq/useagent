import type {
  ConnectionProjection,
  IntegrationActionCatalogEntry,
} from "@skynet/agent-client/integrations";
import {
  createIntegrationConnectSession,
  finalizeIntegrationConnectSession,
  findActiveIntegrationConnectSession,
} from "./connect-sessions";
import {
  findVisibleIntegrationConnectionRecord,
  listVisibleIntegrationConnections,
  updateOwnedIntegrationConnection,
} from "./connection-repo";
import type {
  DelegatedConnectionBackend,
  IntegrationActorScope,
  ManagedConnectionBackend,
} from "./backend";
import { managedConnectionBackends } from "./managed-backends";
import { createOpenConnectorBackend, openConnectorConfigFromEnv } from "./open-connector";
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
  return {
    managedBackends: managedConnectionBackends,
    delegatedBackends: openConnector ? [createOpenConnectorBackend(openConnector)] : [],
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

export function createIntegrationService(
  deps: IntegrationServiceDependencies = defaultDependencies(),
) {
  function delegatedBackend(provider: string): DelegatedConnectionBackend | null {
    return deps.delegatedBackends.find((backend) => backend.supports(provider)) ?? null;
  }

  return {
    async listIntegrations(scope: IntegrationActorScope): Promise<IntegrationSummary[]> {
      const [managed, connections, connectableProviders] = await Promise.all([
        Promise.all(deps.managedBackends.map((backend) => backend.readStatus(scope))),
        listVisibleIntegrationConnections(scope),
        Promise.all(
          deps.delegatedBackends.map((backend) =>
            backend.listConnectableProviders().catch(() => []),
          ),
        ).then((providers) => new Set(providers.flat())),
      ]);
      const connectionProviders = new Set(connections.map((connection) => connection.provider));
      const availableDelegated = DELEGATED_INTEGRATION_CATALOG.filter(
        (item) => !connectionProviders.has(item.provider) && delegatedBackend(item.provider),
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
          backend: "openconnector",
          managed: false,
          connectAvailable: connectableProviders.has(item.provider),
          disconnectAvailable: false,
          status: "unavailable",
          connection: null,
        })),
        ...connections.map((connection): IntegrationSummary => ({
          provider: connection.provider,
          displayName: displayName(connection.provider),
          description: `${displayName(connection.provider)} account connection.`,
          backend: connection.provider === "github" || connection.provider === "slack"
            ? "native"
            : "openconnector",
          managed: false,
          connectAvailable: delegatedBackend(connection.provider) !== null,
          disconnectAvailable: connection.status !== "revoked",
          status: connection.status,
          account: connection.account,
          connection,
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
      const backend = delegatedBackend(input.provider);
      if (!backend) throw new Error("integration provider is not connectable");
      const connectable = await backend.listConnectableProviders();
      if (!connectable.includes(input.provider)) {
        throw new Error("integration provider OAuth is not configured");
      }
      const started = await backend.startConnect(input);
      const session = await createIntegrationConnectSession({
        orgId: input.orgId,
        actorUserId: input.userId,
        owner: input.owner,
        provider: input.provider,
        runtimeBindingId: started.runtimeBindingId,
        backendSessionRef: started.backendSessionRef,
        returnTo: input.returnTo,
        expiresAt: started.expiresAt,
      });
      return {
        redirectUrl: started.redirectUrl,
        state: session.state,
        expiresAt: session.expiresAt.toISOString(),
      };
    },

    async completeConnect(input: IntegrationActorScope & { readonly state: string }) {
      const sessionScope = {
        orgId: input.orgId,
        actorUserId: input.userId,
        state: input.state,
      };
      const pending = await findActiveIntegrationConnectSession(sessionScope);
      if (!pending) throw new Error("integration connect session is invalid or expired");
      const backend = delegatedBackend(pending.provider);
      if (!backend || backend.runtimeBindingId !== pending.runtimeBindingId) {
        throw new Error("integration backend is unavailable");
      }
      const result = await backend.completeConnect({
        ...input,
        provider: pending.provider,
        backendSessionRef: pending.backendSessionRef,
      });
      const connection = await finalizeIntegrationConnectSession({
        orgId: input.orgId,
        actorUserId: input.userId,
        state: input.state,
        result,
      });
      if (!connection) throw new Error("integration connect session was already consumed");
      publishOrgChange(input.orgId, {
        type: "integration_connection",
        action: "created",
        connectionId: connection.id,
        provider: connection.provider,
        ...(connection.owner.type === "user" ? { targetUserId: connection.owner.userId } : {}),
      });
      return connection;
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
      const backend = delegatedBackend(record.provider);
      if (!backend || backend.runtimeBindingId !== record.runtimeBindingId) {
        throw new Error("integration backend is unavailable");
      }
      await backend.disconnect({ ...input, connection: record });
      const owner = ownerForRecord(record);
      const connection = await updateOwnedIntegrationConnection({
        orgId: input.orgId,
        owner,
        id: record.id,
        status: "revoked",
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
          const backend = delegatedBackend(record.provider);
          if (!backend || backend.runtimeBindingId !== record.runtimeBindingId) return [];
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
      const backend = delegatedBackend(record.provider);
      if (!backend || backend.runtimeBindingId !== record.runtimeBindingId) {
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
