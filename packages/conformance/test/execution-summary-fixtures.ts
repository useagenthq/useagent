import type { CanonicalThreadEvent } from "@useagent/agent-client";
import { CANONICAL_SCHEMA_VERSION, type CanonicalEventBody } from "@useagent/agent-harness/canonical";

function event(
  ordinal: number,
  childIndex: number,
  childOwned: boolean,
  body: CanonicalEventBody,
): CanonicalThreadEvent {
  const childId = `child-${childIndex + 1}`;
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    eventId: `summary-event-${ordinal}`,
    seq: ordinal,
    runId: "summary-benchmark-run",
    threadId: "summary-benchmark-thread",
    ts: ordinal,
    identity: {
      provider: "benchmark",
      nativeSessionId: childOwned ? childId : "benchmark-parent",
      nativeEventId: `summary-native-${ordinal}`,
      nativeSeq: ordinal,
    },
    deliverySeq: ordinal,
    revision: 0,
    ...body,
  } as CanonicalThreadEvent;
}

export function executionSummaryEvents(
  eventCount: number,
  childCount: number,
): CanonicalThreadEvent[] {
  if (!Number.isInteger(eventCount) || eventCount < childCount) {
    throw new Error("eventCount must be an integer at least as large as childCount");
  }
  if (!Number.isInteger(childCount) || childCount < 1) {
    throw new Error("childCount must be a positive integer");
  }

  return Array.from({ length: eventCount }, (_, zeroBased) => {
    const ordinal = zeroBased + 1;
    const childIndex = zeroBased % childCount;
    const childId = `child-${childIndex + 1}`;
    const cycle = Math.floor(zeroBased / childCount);
    switch (cycle % 6) {
      case 0:
        return event(ordinal, childIndex, false, {
          kind: "child.started",
          childId,
          title: `Research worker ${childIndex + 1}`,
          state: { status: "running", summary: "Starting" },
        });
      case 1:
        return event(ordinal, childIndex, true, {
          kind: "tool.started",
          toolCallId: `tool-${ordinal}`,
          name: cycle % 12 === 1 ? "web_search" : "read_file",
        });
      case 2:
        return event(ordinal, childIndex, false, {
          kind: "child.updated",
          childId,
          status: "running",
          state: {
            status: "running",
            summary: `Processed batch ${cycle}`,
            lastToolName: cycle % 12 === 2 ? "web_search" : "read_file",
          },
        });
      case 3:
        return event(ordinal, childIndex, true, {
          kind: "message.delta",
          messageId: `message-${childIndex + 1}`,
          text: `Progress chunk ${cycle} for ${childId}`,
        });
      case 4:
        return event(ordinal, childIndex, true, {
          kind: "tool.completed",
          toolCallId: `tool-${ordinal - childCount * 3}`,
          status: "ok",
          preview: "done",
        });
      default:
        return event(ordinal, childIndex, false, {
          kind: "child.completed",
          childId,
          status: "ok",
          result: `Result ${cycle} for ${childId}`,
          state: { status: "ok", summary: "Finished" },
        });
    }
  });
}

export function revisedExecutionSummaryEvent(
  source: CanonicalThreadEvent,
  revision: number,
): CanonicalThreadEvent {
  if (source.kind !== "child.updated") {
    throw new Error("revision fixture requires a child.updated event");
  }
  return {
    ...source,
    revision,
    status: "running-revised",
    state: {
      ...source.state,
      status: "running-revised",
      summary: `Revised at ${revision}`,
    },
  };
}
