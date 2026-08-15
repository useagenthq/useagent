import { EventEmitter } from "node:events";
import { publishThreadChange, type ThreadChangeKind } from "./thread-signals";

/** IDs-only invalidation events for org-scoped ambient product surfaces. */
export type OrgChange =
  | {
      readonly type: "run";
      readonly action: ThreadChangeKind;
      readonly runId: string;
      readonly threadId: string;
    }
  | {
      readonly type: "artifact";
      readonly action: "created" | "updated";
      readonly artifactId: string;
      readonly runId: string;
      readonly threadId: string;
    };

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
