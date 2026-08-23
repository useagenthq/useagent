import { EventEmitter } from "node:events";
import type { OrgChange as ClientOrgChange } from "@useagent/agent-client/org-changes";
import type {
  ProviderConnectionAuthMethod,
  ProviderConnectionChangeAction,
  ProviderConnectionProvider,
  ProviderConnectionStatus,
} from "@useagent/agent-client/provider-connections";
import type {
  IntegrationConnectionChangeAction,
} from "@useagent/agent-client/integrations";
import { publishThreadChange, type ThreadChangeKind } from "./thread-signals";

/** Internal invalidation events for ambient product surfaces. */
export type OrgChange =
  | Exclude<
      ClientOrgChange,
      { readonly type: "provider_connection" | "integration_connection" }
    >
  | {
      readonly type: "provider_connection";
      readonly action: ProviderConnectionChangeAction;
      readonly targetUserId: string;
      readonly connectionId: string;
      readonly provider: ProviderConnectionProvider;
      readonly authMethod: ProviderConnectionAuthMethod;
      readonly status: ProviderConnectionStatus;
    }
  | {
      readonly type: "integration_connection";
      readonly action: IntegrationConnectionChangeAction;
      readonly connectionId: string;
      readonly provider: string;
      readonly targetUserId?: string;
    };

export type { ClientOrgChange };

export type OrgChangeListener = (change: OrgChange) => void;

const orgBus = new EventEmitter();
orgBus.setMaxListeners(0);

const orgChannel = (orgId: string): string => `org:${orgId}`;

export function subscribeOrg(orgId: string, listener: OrgChangeListener): () => void {
  const channel = orgChannel(orgId);
  const guarded: OrgChangeListener = (change) => {
    try {
      listener(change);
    } catch (error) {
      console.error(`[org-signals] listener threw for org ${orgId}:`, error);
    }
  };
  orgBus.on(channel, guarded);
  return () => orgBus.off(channel, guarded);
}

/** Publish only after the durable state change commits. Never throws into callers. */
export function publishOrgChange(orgId: string, change: OrgChange): void {
  try {
    orgBus.emit(orgChannel(orgId), change);
  } catch (error) {
    console.error(`[org-signals] publish failed for org ${orgId}:`, error);
  }
}

export function clientOrgChangeForUser(
  change: OrgChange,
  userId: string | null,
): ClientOrgChange | null {
  if (change.type === "provider_connection") {
    if (!userId || change.targetUserId !== userId) return null;
    return {
      type: "provider_connection",
      action: change.action,
      provider: change.provider,
      authMethod: change.authMethod,
    };
  }
  if (change.type === "integration_connection") {
    if (change.targetUserId && change.targetUserId !== userId) return null;
    return {
      type: "integration_connection",
      action: change.action,
      connectionId: change.connectionId,
      provider: change.provider,
    };
  }
  return change;
}

/** One production seam keeps the active-thread and ambient-org projections in sync. */
export function publishRunLifecycleChange(input: {
  readonly orgId: string | null;
  readonly threadId: string;
  readonly runId: string;
  readonly kind: ThreadChangeKind;
}): void {
  publishThreadChange(input.threadId, { runId: input.runId, kind: input.kind });
  if (!input.orgId) return;
  publishOrgChange(input.orgId, {
    type: "run",
    action: input.kind,
    runId: input.runId,
    threadId: input.threadId,
  });
}
