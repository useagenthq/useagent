import type {
  IntegrationActionCatalogEntry,
  IntegrationConnectionAccount,
} from "@useagent/agent-client/integrations";
import type { IntegrationConnectionRecord } from "./connection-repo";
import type { IntegrationConnectionAuthMethod } from "./types";

export interface IntegrationActorScope {
  readonly orgId: string;
  readonly userId: string;
}

export interface ManagedConnectionStatus {
  readonly provider: string;
  readonly label: string;
  readonly description: string;
  readonly status: "connected" | "unavailable";
  readonly account?: IntegrationConnectionAccount;
}

export interface DelegatedConnectionStart {
  readonly backendSessionRef: string;
  readonly runtimeBindingId: string;
  readonly redirectUrl: string;
  readonly expiresAt: Date;
}

export interface DelegatedConnectionResult {
  readonly runtimeBindingId: string;
  readonly externalConnectionId: string;
  readonly externalConnectionName?: string | null;
  readonly authMethod: IntegrationConnectionAuthMethod;
  readonly account: IntegrationConnectionAccount;
  readonly scopes: readonly string[];
  /** Trusted server-only material persisted atomically with the safe projection. */
  readonly credential?: {
    readonly format: string;
    readonly serialized: string;
  };
  readonly workspaceBinding?: {
    readonly externalWorkspaceId: string;
    readonly externalActorId?: string;
  };
}

export type IntegrationConnectCallback = Readonly<Record<string, string>>;

export type ConnectionBackend = ManagedConnectionBackend | DelegatedConnectionBackend;

export interface ManagedConnectionBackend {
  readonly kind: "managed";
  readonly provider: string;
  readStatus(scope: IntegrationActorScope): Promise<ManagedConnectionStatus>;
}

export interface DelegatedConnectionBackend {
  readonly kind: "delegated";
  readonly runtimeBindingId: string;
  readonly disconnectSupported: boolean;
  supports(provider: string): boolean;
  listConnectableProviders(): Promise<readonly string[]>;
  startConnect(
    input: IntegrationActorScope & {
      readonly provider: string;
      readonly state: string;
    },
  ): Promise<DelegatedConnectionStart>;
  completeConnect(input: IntegrationActorScope & {
    readonly provider: string;
    readonly backendSessionRef: string;
    readonly callback?: IntegrationConnectCallback;
  }): Promise<DelegatedConnectionResult>;
  disconnect(input: IntegrationActorScope & {
    readonly connection: IntegrationConnectionRecord;
  }): Promise<void>;
  listActions(input: IntegrationActorScope & {
    readonly connection: IntegrationConnectionRecord;
  }): Promise<readonly IntegrationActionCatalogEntry[]>;
  executeAction(input: IntegrationActorScope & {
    readonly connection: IntegrationConnectionRecord;
    readonly actionId: string;
    readonly input: unknown;
    readonly idempotencyKey?: string;
  }): Promise<unknown>;
}
