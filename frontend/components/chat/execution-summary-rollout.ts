import {
  createExecutionSummaryProjector,
  type CanonicalThreadEvent,
  type ExecutionSummarySnapshot,
} from "@useagent/agent-client";
import {
  type CanonicalChildEventLike,
  type ChildrenView,
  deriveChildrenView,
} from "./canonical-children";
import type { CanonicalEventLike } from "./canonical-timeline";
import type { NativeFrame } from "./native-events";
import type { ApiStep } from "./types";

export type ExecutionSummaryRolloutMode = "off" | "shadow" | "read";

export interface ExecutionSummaryDiagnostic {
  readonly code: "invalid-input" | "invalid-snapshot" | "view-mismatch";
  readonly legacyCards: number;
  readonly projectedCards: number | null;
  readonly legacyFingerprint: string;
  readonly projectedFingerprint: string | null;
}

export interface ExecutionSummaryRolloutOptions {
  readonly mode?: ExecutionSummaryRolloutMode;
  /** Receives bounded aggregate evidence only; no transcripts or raw event data. */
  readonly onDiagnostic?: (diagnostic: ExecutionSummaryDiagnostic) => void;
}

export function parseExecutionSummaryRolloutMode(
  value: string | undefined,
): ExecutionSummaryRolloutMode {
  return value === "shadow" || value === "read" ? value : "off";
}

/** Explicit rollback flag. Missing, invalid, and `off` values preserve legacy rendering. */
export const EXECUTION_SUMMARY_ROLLOUT_MODE = parseExecutionSummaryRolloutMode(
  process.env.NEXT_PUBLIC_EXECUTION_SUMMARY_ROLLOUT,
);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isProjectableEvent(event: CanonicalChildEventLike): boolean {
  const stored = event as Partial<CanonicalThreadEvent>;
  return (
    stored.schemaVersion === 1 &&
    isNonEmptyString(stored.eventId) &&
    isNonEmptyString(stored.runId) &&
    isNonEmptyString(stored.threadId) &&
    typeof stored.deliverySeq === "number" &&
    Number.isFinite(stored.deliverySeq) &&
    stored.deliverySeq > 0 &&
    typeof stored.revision === "number" &&
    Number.isFinite(stored.revision) &&
    stored.revision >= 0 &&
    typeof stored.seq === "number" &&
    Number.isFinite(stored.seq) &&
    (stored.ts === undefined || (typeof stored.ts === "number" && Number.isFinite(stored.ts))) &&
    isNonEmptyString(stored.identity?.provider)
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isValidSnapshot(snapshot: ExecutionSummarySnapshot): boolean {
  const ids = new Set<string>();
  for (const child of snapshot.children) {
    if (!isNonEmptyString(child.id) || ids.has(child.id)) return false;
    if (
      !Array.isArray(child.aliases) ||
      !child.aliases.every(isNonEmptyString) ||
      !child.aliases.includes(child.id) ||
      !isNonEmptyString(child.identity.provider) ||
      !isNullableString(child.identity.nativeSessionId) ||
      !isNullableString(child.identity.nativeParentSessionId) ||
      !isNonEmptyString(child.runId) ||
      !Number.isFinite(child.startedSeq) ||
      !Number.isFinite(child.startedAt) ||
      !Number.isFinite(child.lastActivitySeq) ||
      !Number.isFinite(child.lastActivityAt) ||
      !isNullableString(child.parentId) ||
      !isNullableString(child.title) ||
      !isNullableString(child.prompt) ||
      !isNullableString(child.role) ||
      !isNullableString(child.model) ||
      !isNonEmptyString(child.status) ||
      !isNullableString(child.summary) ||
      !isNullableString(child.lastToolName) ||
      !isNullableString(child.lastToolStatus) ||
      !isNullableString(child.lastMessagePreview) ||
      !isNullableString(child.result) ||
      (child.resumable !== null && typeof child.resumable !== "boolean") ||
      (child.usage !== null &&
        (typeof child.usage !== "object" ||
          Array.isArray(child.usage) ||
          Object.values(child.usage).some(
            (value) => typeof value !== "number" || !Number.isFinite(value),
          )))
    )
      return false;
    if (child.parentId === child.id) return false;
    ids.add(child.id);
  }
  return snapshot.delegationEdges.every(
    (edge) => ids.has(edge.childId) && edge.parentId !== edge.childId,
  );
}

function summaryEvents(snapshot: ExecutionSummarySnapshot): CanonicalChildEventLike[] | null {
  const projected: CanonicalChildEventLike[] = [];

  for (const child of snapshot.children) {
    const launchToolCallId = child.aliases.find((alias) => alias !== child.id);
    const state = {
      status: child.status,
      ...(child.prompt !== null ? { prompt: child.prompt } : {}),
      ...(child.summary !== null ? { summary: child.summary } : {}),
      ...(child.lastToolName !== null ? { lastToolName: child.lastToolName } : {}),
      ...(child.usage !== null ? { usage: child.usage } : {}),
      ...(child.model !== null ? { model: child.model } : {}),
      ...(child.role !== null ? { role: child.role } : {}),
      ...(child.resumable !== null ? { resumable: child.resumable } : {}),
    };
    projected.push({
      kind: "child.started",
      seq: child.startedSeq,
      ts: child.startedAt,
      runId: child.runId,
      childId: child.id,
      ...(child.parentId !== null ? { parentChildId: child.parentId } : {}),
      ...(launchToolCallId ? { launchToolCallId } : {}),
      ...(child.title !== null ? { title: child.title } : {}),
      state,
    });
    if (child.status === "ok" || child.status === "error") {
      projected.push({
        kind: "child.completed",
        seq: child.lastActivitySeq,
        ts: child.lastActivityAt,
        runId: child.runId,
        childId: child.id,
        status: child.status,
        ...(child.result !== null ? { result: child.result } : {}),
        state,
      });
    }
  }
  return projected;
}

function fingerprint(view: ChildrenView): string {
  let comparable: string;
  try {
    comparable = JSON.stringify({
      cards: view.cards,
      ownerByStep: [...view.ownerByStep].toSorted(([a], [b]) => a.localeCompare(b)),
      fidelity: [...view.fidelity].toSorted(([a], [b]) => a.localeCompare(b)),
    });
  } catch {
    return "unavailable";
  }
  let hash = 2_166_136_261;
  for (let index = 0; index < comparable.length; index++) {
    hash ^= comparable.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function diagnostic(
  code: ExecutionSummaryDiagnostic["code"],
  legacy: ChildrenView,
  projected: ChildrenView | null,
): ExecutionSummaryDiagnostic {
  return {
    code,
    legacyCards: legacy.cards.length,
    projectedCards: projected?.cards.length ?? null,
    legacyFingerprint: fingerprint(legacy),
    projectedFingerprint: projected ? fingerprint(projected) : null,
  };
}

function emitDiagnostic(
  options: ExecutionSummaryRolloutOptions,
  value: ExecutionSummaryDiagnostic,
): void {
  try {
    options.onDiagnostic?.(value);
  } catch {
    // Diagnostics are observational. They must never affect rendered children.
  }
}

function applyExecutionSummarySnapshot(
  legacy: ChildrenView,
  steps: readonly ApiStep[],
  frames: readonly NativeFrame[],
  snapshot: ExecutionSummarySnapshot | null,
  options: ExecutionSummaryRolloutOptions,
): ChildrenView {
  const mode = options.mode ?? EXECUTION_SUMMARY_ROLLOUT_MODE;
  if (mode === "off") return legacy;

  if (!snapshot) {
    emitDiagnostic(options, diagnostic("invalid-input", legacy, null));
    return legacy;
  }
  if (!isValidSnapshot(snapshot)) {
    emitDiagnostic(options, diagnostic("invalid-snapshot", legacy, null));
    return legacy;
  }
  try {
    const events = summaryEvents(snapshot);
    if (!events) {
      emitDiagnostic(options, diagnostic("invalid-snapshot", legacy, null));
      return legacy;
    }
    const projected = deriveChildrenView(steps, frames, events);
    if (fingerprint(legacy) !== fingerprint(projected)) {
      emitDiagnostic(options, diagnostic("view-mismatch", legacy, projected));
    }
    return mode === "read" ? projected : legacy;
  } catch {
    emitDiagnostic(options, diagnostic("invalid-snapshot", legacy, null));
    return legacy;
  }
}

/** Production seam: consumes the root thread store's incremental snapshot. */
export function deriveChildrenViewFromExecutionSummary(
  steps: readonly ApiStep[],
  frames: readonly NativeFrame[],
  canonicalEvents: readonly CanonicalEventLike[],
  snapshot: ExecutionSummarySnapshot | null,
  options: ExecutionSummaryRolloutOptions = {},
): ChildrenView {
  const legacy = deriveChildrenView(steps, frames, canonicalEvents);
  return applyExecutionSummarySnapshot(legacy, steps, frames, snapshot, options);
}

/**
 * Parity-only helper retained for focused tests. Production consumers must read
 * the store-owned snapshot via deriveChildrenViewFromExecutionSummary.
 */
export function deriveChildrenViewWithExecutionSummary(
  steps: readonly ApiStep[],
  frames: readonly NativeFrame[],
  canonicalEvents: readonly CanonicalEventLike[],
  options: ExecutionSummaryRolloutOptions = {},
): ChildrenView {
  const legacy = deriveChildrenView(steps, frames, canonicalEvents);
  const mode = options.mode ?? EXECUTION_SUMMARY_ROLLOUT_MODE;
  if (mode === "off") return legacy;
  if (!canonicalEvents.every(isProjectableEvent)) {
    emitDiagnostic(options, diagnostic("invalid-input", legacy, null));
    return legacy;
  }
  let snapshot: ExecutionSummarySnapshot;
  try {
    const projector = createExecutionSummaryProjector();
    for (const event of canonicalEvents as unknown as readonly CanonicalThreadEvent[]) {
      projector.ingest(event);
    }
    snapshot = projector.snapshot();
  } catch {
    emitDiagnostic(options, diagnostic("invalid-input", legacy, null));
    return legacy;
  }
  return applyExecutionSummarySnapshot(legacy, steps, frames, snapshot, options);
}
