// Pure logic for the gateway approval lane (#77): the timeline-integration
// decision (does this run's projection signal a gateway approval?), the
// one-level argument summary, and the card's optimistic resolution machine.
// No fetching here - the wire contract lives in lib/gateway-approvals.ts.

import type { StoredCanonicalEvent } from "./canonical-timeline";
import type { NativeFrame } from "./native-events";
import type { ApiStep } from "./types";
import type {
  GatewayApprovalDecision,
  GatewayApprovalStatus,
} from "@/lib/gateway-approvals";

const APPROVAL = /approval/i;

/**
 * Timeline-integration decision, mirroring how the question card derives its
 * render from the run's own projection: a pending gateway approval also lands
 * in the run timeline as a step / provider event whose kind, chip, or
 * eventType contains "approval". Returns a SIGNATURE string ("" = no signal)
 * that changes whenever an approval event re-projects through the thread SSE,
 * so the fetch lane revalidates on stream merges instead of polling.
 *
 * The provider-native T3 approval lane (`approval.*` frames with provider
 * "t3") is EXCLUDED - NativeApprovalCard owns those; this lane only reacts to
 * gateway approvals served by GET /api/gateway/approvals.
 */
export function gatewayApprovalSignature(
  steps: readonly ApiStep[],
  frames: readonly NativeFrame[],
  canonical: readonly StoredCanonicalEvent[] = [],
): string {
  const parts: string[] = [];
  for (const step of steps) {
    if (APPROVAL.test(step.kind) || APPROVAL.test(step.chip ?? "")) {
      parts.push(`step:${step.id}`);
    }
  }
  for (const frame of frames) {
    if (frame.provider !== "t3" && APPROVAL.test(frame.eventType)) {
      parts.push(`frame:${frame.eventId}:${frame.seq}`);
    }
  }
  for (const event of canonical) {
    if (APPROVAL.test(event.kind)) {
      parts.push(`canonical:${event.eventId}:${event.revision}`);
    }
  }
  return parts.join("|");
}

export function hasGatewayApprovalSignal(
  steps: readonly ApiStep[],
  frames: readonly NativeFrame[],
  canonical: readonly StoredCanonicalEvent[] = [],
): boolean {
  return gatewayApprovalSignature(steps, frames, canonical) !== "";
}

// ── Argument summary ────────────────────────────────────────────────────────

export interface ApprovalArgumentEntry {
  readonly key: string;
  readonly value: string;
}

const MAX_VALUE_CHARS = 80;

/** One-level readable summary: every top-level key with its value rendered as
 *  a truncated single line (strings verbatim, everything else JSON). */
export function summarizeApprovalArguments(
  args: Readonly<Record<string, unknown>>,
): ApprovalArgumentEntry[] {
  return Object.entries(args).map(([key, value]) => {
    const text =
      typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
    const flat = text.replaceAll("\n", " ");
    return {
      key,
      value: flat.length > MAX_VALUE_CHARS ? `${flat.slice(0, MAX_VALUE_CHARS - 1)}…` : flat,
    };
  });
}

// ── Optimistic resolution machine ───────────────────────────────────────────

export type ApprovalResolution =
  | { readonly phase: "idle"; readonly error: string | null }
  | { readonly phase: "submitting"; readonly decision: GatewayApprovalDecision }
  | { readonly phase: "resolved"; readonly status: GatewayApprovalStatus };

export const idleResolution: ApprovalResolution = { phase: "idle", error: null };

/** Enter the optimistic submit; a second click while in flight is a no-op. */
export function beginResolution(
  current: ApprovalResolution,
  decision: GatewayApprovalDecision,
): ApprovalResolution {
  return current.phase === "submitting" ? current : { phase: "submitting", decision };
}

export function resolutionSucceeded(status: GatewayApprovalStatus): ApprovalResolution {
  return { phase: "resolved", status };
}

/** Roll the optimistic transition back to pending, carrying the user-facing
 *  failure copy for the httpStatus the API returned. */
export function resolutionFailed(httpStatus: number | null): ApprovalResolution {
  return { phase: "idle", error: resolutionErrorMessage(httpStatus) };
}

export function resolutionErrorMessage(httpStatus: number | null): string {
  if (httpStatus === 403) return "An org member must approve this";
  if (httpStatus === 409) return "Already resolved by someone else - refreshing";
  return "Could not send your decision - try again";
}

/** The status the card renders: the server record unless a local optimistic or
 *  confirmed resolution overlays a still-pending record. A server-resolved
 *  record always wins (the durable truth). */
export function effectiveStatus(
  record: GatewayApprovalStatus,
  resolution: ApprovalResolution,
): GatewayApprovalStatus {
  if (record !== "pending") return record;
  if (resolution.phase === "submitting") {
    return resolution.decision === "approve" ? "approved" : "denied";
  }
  if (resolution.phase === "resolved") return resolution.status;
  return record;
}
