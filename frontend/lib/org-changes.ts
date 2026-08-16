import { decodeOrgChange, type OrgChange } from "@skynet/agent-client/org-changes";

export type { OrgChange };

type Listener = (change: OrgChange) => void;
export const parseOrgChange = decodeOrgChange;

const listeners = new Set<Listener>();
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
    change.type === "run"
      ? `run:${change.runId}`
      : change.type === "artifact"
        ? `artifact:${change.artifactId}`
        : change.type === "automation"
          ? `automation:${change.automationId}`
          : `provider_connection:${change.provider}:${change.authMethod}`;
  pending.set(key, change);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

function connect(): void {
  if (source || typeof window === "undefined") return;
  source = new EventSource("/api/runs/changes");
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
 * surfaces share one EventSource; the browser handles reconnect and each view
 * retains its low-frequency snapshot poll as the durable recovery path.
 */
export function subscribeOrgChanges(listener: Listener): () => void {
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0) return;
    source?.close();
    source = null;
    pending.clear();
    flushScheduled = false;
  };
}
