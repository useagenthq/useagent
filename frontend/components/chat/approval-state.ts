import type { NativeFrame } from "./native-events";
import { asRecord } from "./types";

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface PendingApproval {
  readonly id: string;
  readonly sessionId: string;
  readonly requestKind: "command" | "file-read" | "file-change" | "other";
  readonly detail?: string;
}

function parseApproval(frame: NativeFrame): PendingApproval | null {
  const payload = asRecord(frame.payload);
  if (typeof payload?.id !== "string" || typeof payload.sessionID !== "string") return null;
  const rawKind = payload.requestKind;
  const requestKind =
    rawKind === "command" || rawKind === "file-read" || rawKind === "file-change"
      ? rawKind
      : "other";
  return {
    id: payload.id,
    sessionId: payload.sessionID,
    requestKind,
    ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
  };
}

export function selectPendingApproval(frames: readonly NativeFrame[]): PendingApproval | null {
  const pending = new Map<string, PendingApproval>();
  for (const frame of [...frames].sort((a, b) => a.seq - b.seq)) {
    if (frame.provider !== "t3") continue;
    if (frame.eventType === "approval.requested") {
      const approval = parseApproval(frame);
      if (approval) pending.set(approval.id, approval);
      continue;
    }
    if (frame.eventType === "approval.responded" || frame.eventType === "approval.resolved") {
      const payload = asRecord(frame.payload);
      const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
      if (requestId) pending.delete(requestId);
    }
  }
  return [...pending.values()].at(-1) ?? null;
}
