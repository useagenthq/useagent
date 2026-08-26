import type { ContextMarkerKind } from "./canonical";
import { stringValue } from "./opencode-values";

export interface UseAgentContextMarker {
  markerType: ContextMarkerKind;
  title: string;
  detail?: string;
}

export function markerFromUseAgent(
  eventType: string,
  payload: Record<string, unknown> | null,
): UseAgentContextMarker | null {
  if (eventType === "skill.loaded") {
    const playbook = payload?.kind === "playbook";
    return {
      markerType: playbook ? "playbook" : "skill",
      title: stringValue(payload?.name) ?? (playbook ? "playbook" : "skill"),
      detail: typeof payload?.version === "number" ? `v${payload.version}` : undefined,
    };
  }
  if (
    eventType === "context.retrieved" ||
    eventType === "knowledge.retrieved" ||
    eventType === "memory.searched"
  ) {
    const source =
      stringValue(payload?.source) ??
      (eventType === "knowledge.retrieved" ? "knowledge" : "memory");
    const count = typeof payload?.itemCount === "number" ? payload.itemCount : 0;
    return {
      markerType: source === "knowledge" ? "knowledge" : "memory",
      title: `Recalled ${count} item${count === 1 ? "" : "s"} from ${source}`,
    };
  }
  if (
    eventType === "memory.l0_accepted" ||
    eventType === "memory.updated" ||
    eventType === "memory.deleted" ||
    eventType === "memory.failed"
  ) {
    const failed = eventType === "memory.failed";
    const operation =
      stringValue(payload?.op) ??
      (eventType === "memory.updated"
        ? "correct"
        : eventType === "memory.deleted"
          ? "forget"
          : "remember");
    return {
      markerType: "memory",
      title: failed ? `Memory ${operation} failed` : `Memory ${operation}`,
    };
  }
  if (eventType === "run.reconciling") {
    return { markerType: "reconciling", title: "Reconciling after a restart" };
  }
  return null;
}
