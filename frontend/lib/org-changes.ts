export type OrgChange =
  | {
      readonly type: "run";
      readonly action: "created" | "running" | "settled" | "cancelled";
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

type Listener = (change: OrgChange) => void;
type RunAction = Extract<OrgChange, { type: "run" }>["action"];
type ArtifactAction = Extract<OrgChange, { type: "artifact" }>["action"];

const RUN_ACTIONS = new Set<RunAction>(["created", "running", "settled", "cancelled"]);
const ARTIFACT_ACTIONS = new Set<ArtifactAction>(["created", "updated"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOrgChange(value: unknown): OrgChange | null {
  if (!isRecord(value)) return null;
  const { type, action, runId, threadId } = value;
  if (typeof runId !== "string" || typeof threadId !== "string") return null;
  if (type === "run" && typeof action === "string" && RUN_ACTIONS.has(action as RunAction)) {
    return { type, action: action as RunAction, runId, threadId };
  }
  if (
    type === "artifact" &&
    typeof action === "string" &&
    ARTIFACT_ACTIONS.has(action as ArtifactAction) &&
    typeof value.artifactId === "string"
  ) {
    return {
      type,
      action: action as ArtifactAction,
      artifactId: value.artifactId,
      runId,
      threadId,
    };
  }
  return null;
}

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
  const key = change.type === "run" ? `run:${change.runId}` : `artifact:${change.artifactId}`;
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
