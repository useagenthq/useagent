import type { OpenCodeFrame } from "./opencode-types";
import {
  boundedPreview,
  firstString,
  numberValue,
  recordValue,
} from "./opencode-values";
import { firstSemanticT3ToolName, t3SummaryToolIdentity } from "./t3-tool";

export function t3Payload(
  activity: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return recordValue(activity?.payload);
}

export function t3ActivityKind(
  eventType: string,
  activity: Record<string, unknown> | null,
): string {
  return typeof activity?.kind === "string" ? activity.kind : eventType.slice("t3.activity.".length);
}

export type T3DelegationKind = "spawn" | "wait" | "send" | "resume" | "close";

/** Exact provider control kind. Prefer the normalized field from the current
 * T3 bridge, then recover older durable frames from their raw Codex item. */
export function t3DelegationKind(
  payload: Record<string, unknown> | null,
): T3DelegationKind | null {
  const data = recordValue(payload?.data);
  const item = recordValue(data?.item);
  const normalized = firstString(payload?.delegationKind);
  if (
    normalized === "spawn" ||
    normalized === "wait" ||
    normalized === "send" ||
    normalized === "resume" ||
    normalized === "close"
  ) {
    return normalized;
  }
  switch (firstString(item?.tool)) {
    case "spawnAgent":
      return "spawn";
    case "wait":
      return "wait";
    case "sendInput":
      return "send";
    case "resumeAgent":
      return "resume";
    case "closeAgent":
      return "close";
    default:
      return null;
  }
}

export function t3ToolName(payload: Record<string, unknown> | null, summary?: unknown): string {
  const data = recordValue(payload?.data);
  const item = recordValue(data?.item);
  const summaryIdentity = t3SummaryToolIdentity(summary);
  const semanticName = firstSemanticT3ToolName(
    payload?.toolName,
    data?.toolName,
    item?.toolName,
    payload?.tool,
    data?.tool,
    item?.tool,
    item?.name,
    item?.title,
    summaryIdentity?.tool,
  );
  return semanticName ?? firstSemanticT3ToolName(payload?.itemType) ?? "tool";
}

export function t3ToolServer(payload: Record<string, unknown> | null, summary?: unknown): string | undefined {
  const data = recordValue(payload?.data);
  const item = recordValue(data?.item);
  return firstString(
    payload?.server,
    data?.server,
    item?.server,
    t3SummaryToolIdentity(summary)?.server,
  ) ?? undefined;
}

export function t3ToolStatus(payload: Record<string, unknown> | null): string | undefined {
  const data = recordValue(payload?.data);
  const item = recordValue(data?.item);
  return firstString(payload?.status, data?.status, item?.status) ?? undefined;
}

export function t3ToolDuration(payload: Record<string, unknown> | null): number | undefined {
  const data = recordValue(payload?.data);
  const item = recordValue(data?.item);
  return (
    numberValue(payload?.durationMs) ??
    numberValue(recordValue(payload?.typedUsage)?.durationMs) ??
    numberValue(data?.durationMs) ??
    numberValue(item?.durationMs) ??
    undefined
  );
}

function previewValue(value: unknown): string | undefined {
  if (typeof value === "string") return boundedPreview(value);
  if (value === undefined || value === null) return undefined;
  try {
    return boundedPreview(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

export function t3ToolCallId(
  frame: OpenCodeFrame,
  activity: Record<string, unknown> | null,
  payload: Record<string, unknown> | null,
): string {
  const data = recordValue(payload?.data);
  const item = recordValue(data?.item);
  return (
    firstString(
      data?.toolCallId,
      payload?.toolCallId,
      item?.id,
      data?.callId,
      data?.callID,
      payload?.callId,
      payload?.callID,
      payload?.toolUseId,
      data?.toolUseId,
      payload?.id,
      activity?.id,
      frame.native.callId,
      frame.eventId,
    ) ?? frame.eventId
  );
}

export function t3Preview(
  activity: Record<string, unknown> | null,
  payload: Record<string, unknown> | null,
): string | undefined {
  const data = recordValue(payload?.data);
  const item = recordValue(data?.item);
  return boundedPreview(
    payload?.summary,
    payload?.detail,
    payload?.error,
    data?.error,
    item?.error,
    item?.text,
    item?.message,
    previewValue(item?.result),
    activity?.detail,
    activity?.summary,
  );
}

export function t3Errored(
  activityKind: string,
  activity: Record<string, unknown> | null,
  payload: Record<string, unknown> | null,
): boolean {
  const data = recordValue(payload?.data);
  const item = recordValue(data?.item);
  const status = firstString(payload?.status, data?.status, item?.status)?.toLowerCase();
  const tone = typeof activity?.tone === "string" ? activity.tone.toLowerCase() : null;
  return (
    activityKind.endsWith(".error") ||
    activityKind.endsWith(".failed") ||
    activityKind.endsWith(".denied") ||
    status === "error" ||
    status === "failed" ||
    status === "denied" ||
    tone === "error" ||
    Boolean(payload?.error) ||
    Boolean(data?.error) ||
    Boolean(item?.error)
  );
}
