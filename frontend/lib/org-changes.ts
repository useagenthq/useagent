import { decodeOrgChange, type OrgChange } from "@useagent/agent-client/org-changes";

export type { OrgChange };

type Listener = (change: OrgChange) => void;
type OpenListener = () => void;
export const parseOrgChange = decodeOrgChange;

const listeners = new Set<Listener>();
const openListeners = new Set<OpenListener>();
const pending = new Map<string, OrgChange>();
let source: EventSource | null = null;
let flushScheduled = false;

function flush(): void {
  flushScheduled = false;
  const changes = [...pending.values()];
  pending.clear();
  for (const change of changes) {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        console.error("[org-changes] listener failed:", error);
      }
    }
  }
}

function enqueue(change: OrgChange): void {
  const key =
    change.type === "execution_graph"
      ? `execution_graph:${change.runId}`
      : change.type === "thread_relationship"
        ? `thread_relationship:${change.familyThreadId}:${change.threadId}`
        : change.type === "run"
          ? `run:${change.runId}`
          : change.type === "artifact"
            ? `artifact:${change.artifactId}`
            : change.type === "automation"
              ? `automation:${change.automationId}`
              : change.type === "integration_connection"
                ? `integration_connection:${change.connectionId}`
                : `provider_connection:${change.provider}:${change.authMethod}`;
  pending.set(key, change);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

function connect(): void {
  if (source || typeof window === "undefined") return;
  source = new EventSource("/api/runs/changes");
  source.addEventListener("open", () => {
    for (const listener of openListeners) {
      try {
        listener();
      } catch (error) {
        console.error("[org-changes] open listener failed:", error);
      }
    }
  });
  source.addEventListener("change", (event) => {
    if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
    try {
      const change = parseOrgChange(JSON.parse(event.data));
      if (change) enqueue(change);
    } catch {
      // Malformed invalidations are ignored; fallback polling repairs the view.
    }
  });
}

/**
 * Subscribe to the page-wide org invalidation stream. All mounted product
 * surfaces share one EventSource; open callbacks let authoritative snapshots
 * repair any invalidations missed while the browser reconnects.
 */
export function subscribeOrgChanges(listener: Listener, onOpen?: OpenListener): () => void {
  listeners.add(listener);
  if (onOpen) openListeners.add(onOpen);
  connect();
  return () => {
    listeners.delete(listener);
    if (onOpen) openListeners.delete(onOpen);
    if (listeners.size !== 0) return;
    source?.close();
    source = null;
    pending.clear();
    flushScheduled = false;
    openListeners.clear();
  };
}
