import {
  createCanonicalThreadStore,
  type CanonicalThreadEvent,
} from "@useagent/agent-client";
import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalEventBody,
} from "@useagent/agent-harness/canonical";
import syntheticFixtures from "./fixtures/child-execution-synthetic.json";

export const SYNTHETIC_FIXTURE_NOTICE =
  "Synthetic adapter-shaped contract fixtures; this proves local canonical semantics only, not adapter parsing or live provider fidelity.";

export type AdapterId =
  | "codex"
  | "codex-acp"
  | "claude-runtime"
  | "claude-acp"
  | "opencode"
  | "acp"
  | "pi"
  | "dsh";

interface SyntheticFixture {
  readonly adapter: AdapterId;
  /** Fixture coverage only; never a claim about the product's negotiated capability. */
  readonly syntheticChildLifecycle: boolean;
  readonly parent: string;
  readonly child: string;
  readonly spawn: Record<string, unknown>;
  readonly activity: Record<string, unknown>;
  readonly wait: Record<string, unknown>;
  readonly result: Record<string, unknown>;
}

export interface ExecutionProjection {
  readonly executionIds: readonly string[];
  readonly childIds: readonly string[];
  readonly delegationEdges: readonly { parentId: string; childId: string }[];
  readonly eventsByExecution: ReadonlyMap<string, readonly CanonicalThreadEvent[]>;
}

export interface ExecutionProjector {
  ingest(event: CanonicalThreadEvent): void;
  snapshot(): ExecutionProjection;
}

const fixtures = syntheticFixtures as SyntheticFixture[];

function stringAt(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  throw new Error(`synthetic fixture is missing ${keys.join("/")}`);
}

function firstArrayString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  throw new Error(`synthetic fixture is missing ${keys.join("/")}`);
}

function identities(fixture: SyntheticFixture): { parent: string; child: string; tool: string } {
  switch (fixture.adapter) {
    case "codex":
      return {
        parent: stringAt(fixture.spawn, "senderThreadId"),
        child: firstArrayString(fixture.spawn, "receiverThreadIds"),
        tool: stringAt(fixture.activity, "itemId"),
      };
    case "claude-runtime":
      return {
        parent: stringAt(fixture.spawn, "parent_tool_use_id"),
        child: stringAt(fixture.spawn, "task_id"),
        tool: stringAt(fixture.activity, "tool_use_id"),
      };
    case "claude-acp":
      return {
        parent: stringAt(fixture.spawn, "sessionId"),
        child: stringAt(fixture.spawn, "childSessionId"),
        tool: stringAt(fixture.activity, "toolCallId"),
      };
    case "codex-acp":
      return {
        parent: stringAt(fixture.spawn, "parentThreadId"),
        child: stringAt(fixture.spawn, "threadId"),
        tool: stringAt(fixture.activity, "toolCallId"),
      };
    case "opencode":
      return {
        parent: stringAt(fixture.spawn, "parentID"),
        child: stringAt(fixture.spawn, "sessionID"),
        tool: stringAt(fixture.activity, "partID"),
      };
    case "acp":
      return {
        parent: stringAt(fixture.spawn, "sessionId"),
        child: stringAt(fixture.spawn, "childSessionId"),
        tool: stringAt(fixture.activity, "toolCallId"),
      };
    case "pi":
      return {
        parent: stringAt(fixture.spawn, "parentSessionId"),
        child: stringAt(fixture.spawn, "subagentId"),
        tool: stringAt(fixture.activity, "callId"),
      };
    case "dsh":
      return {
        parent: stringAt(fixture.spawn, "session_id"),
        child: stringAt(fixture.spawn, "child_session_id"),
        tool: stringAt(fixture.activity, "tool_call_id"),
      };
  }
}

function event(
  fixture: SyntheticFixture,
  ordinal: number,
  nativeSessionId: string,
  body: CanonicalEventBody,
  suffix: string,
): CanonicalThreadEvent {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    eventId: `${fixture.adapter}:${fixture.child}:${suffix}`,
    seq: ordinal,
    runId: "benchmark-run",
    threadId: "benchmark-thread",
    ts: ordinal,
    identity: {
      provider: fixture.adapter,
      nativeSessionId,
      nativeEventId: `${fixture.child}:${suffix}`,
      nativeSeq: ordinal,
    },
    deliverySeq: ordinal,
    revision: 0,
    ...body,
  } as CanonicalThreadEvent;
}

export function normalizeFixture(fixture: SyntheticFixture, offset = 0): CanonicalThreadEvent[] {
  if (!fixture.syntheticChildLifecycle) {
    return [
      event(fixture, offset + 1, fixture.parent, {
        kind: "tool.started",
        toolCallId: `${fixture.adapter}:wait`,
        name: "wait_for_children",
        input: fixture.wait,
      }, "wait-start"),
      event(fixture, offset + 2, fixture.parent, {
        kind: "tool.completed",
        toolCallId: `${fixture.adapter}:wait`,
        status: "ok",
      }, "wait-complete"),
    ];
  }
  const { parent, child, tool } = identities(fixture);
  const at = (n: number) => offset + n;
  return [
    event(fixture, at(1), parent, {
      kind: "child.started",
      childId: child,
      launchToolCallId: `${fixture.adapter}:spawn:${child}`,
      title: `Synthetic ${fixture.adapter} child`,
    }, "spawn"),
    event(fixture, at(2), child, {
      kind: "tool.started",
      toolCallId: tool,
      name: "synthetic_lookup",
    }, "tool-start"),
    event(fixture, at(3), child, {
      kind: "tool.completed",
      toolCallId: tool,
      status: "ok",
      preview: stringAt(fixture.activity, "text"),
    }, "tool-complete"),
    event(fixture, at(4), parent, {
      kind: "child.updated",
      childId: child,
      status: "running",
      state: { status: "running", summary: "checked price", lastToolName: "synthetic_lookup" },
    }, "progress"),
    event(fixture, at(5), child, {
      kind: "message.delta",
      messageId: `${fixture.adapter}:message:${child}`,
      text: "do",
    }, "message-delta"),
    event(fixture, at(6), parent, {
      kind: "tool.started",
      toolCallId: `${fixture.adapter}:wait:${child}`,
      name: "wait_for_children",
      input: fixture.wait,
    }, "wait-start"),
    event(fixture, at(7), parent, {
      kind: "tool.completed",
      toolCallId: `${fixture.adapter}:wait:${child}`,
      status: "ok",
    }, "wait-complete"),
    event(fixture, at(8), child, {
      kind: "message.completed",
      messageId: `${fixture.adapter}:message:${child}`,
      text: stringAt(fixture.result, "result"),
    }, "message"),
    event(fixture, at(9), parent, {
      kind: "child.completed",
      childId: child,
      status: "ok",
      result: stringAt(fixture.result, "result"),
    }, "complete"),
  ];
}

export function normalizeAllFixtures(): CanonicalThreadEvent[] {
  return fixtures.flatMap((fixture, index) => normalizeFixture(fixture, index * 10));
}

export function fixtureEvidenceMatrix() {
  return fixtures.map(({ adapter, syntheticChildLifecycle }) => ({
    adapter,
    syntheticChildLifecycle,
    evidence: "synthetic-fixture-only" as const,
    productCapabilityClaimed: false as const,
  }));
}

export function projectExecutions(events: readonly CanonicalThreadEvent[]): ExecutionProjection {
  const projector = createExecutionProjector();
  for (const event of events.toSorted((a, b) => a.deliverySeq - b.deliverySeq)) {
    projector.ingest(event);
  }
  return projector.snapshot();
}

export function createExecutionProjector(): ExecutionProjector {
  const childIds = new Set<string>();
  const delegationEdges = new Map<string, { parentId: string; childId: string }>();
  const eventsByExecution = new Map<string, Map<string, CanonicalThreadEvent>>();

  return {
    ingest(event) {
      if (event.kind === "child.started") {
        childIds.add(event.childId);
        const parentId = event.parentChildId
          ?? event.identity.nativeParentSessionId
          ?? (event.identity.nativeSessionId !== undefined
            && event.identity.nativeSessionId !== event.childId
            ? event.identity.nativeSessionId
            : event.runId);
        delegationEdges.set(`${parentId}:${event.childId}`, { parentId, childId: event.childId });
      } else if (event.kind === "child.updated" || event.kind === "child.completed") {
        childIds.add(event.childId);
      }
      const executionId = event.identity.nativeSessionId ?? event.runId;
      const existing = eventsByExecution.get(executionId) ?? new Map<string, CanonicalThreadEvent>();
      const previous = existing.get(event.eventId);
      if (
        previous === undefined ||
        event.revision > previous.revision ||
        (event.revision === previous.revision && event.deliverySeq > previous.deliverySeq)
      ) {
        existing.set(event.eventId, event);
      }
      eventsByExecution.set(executionId, existing);
    },
    snapshot() {
      return {
        executionIds: [...eventsByExecution.keys()],
        childIds: [...childIds],
        delegationEdges: [...delegationEdges.values()],
        eventsByExecution: new Map(
          [...eventsByExecution].map(([executionId, byId]) => [
            executionId,
            [...byId.values()].toSorted((a, b) => a.deliverySeq - b.deliverySeq),
          ]),
        ),
      };
    },
  };
}

export function replayThroughCanonicalStore(events: readonly CanonicalThreadEvent[]) {
  const store = createCanonicalThreadStore();
  store.batch(() => {
    for (const event of events) store.ingest(event);
  });
  return store;
}

/** Pure logical accounting only; this does not exercise the durable scheduler or leases. */
export function simulateFanOutAccounting(childCount: number, concurrencyLimit: number) {
  const queued = Array.from({ length: childCount }, (_, index) => `child-${index + 1}`);
  const running = new Set<string>();
  const completed: string[] = [];
  let maxRunning = 0;

  while (queued.length > 0 || running.size > 0) {
    while (running.size < concurrencyLimit && queued.length > 0) {
      running.add(queued.shift()!);
      maxRunning = Math.max(maxRunning, running.size);
    }
    const next = running.values().next().value as string | undefined;
    if (!next) break;
    running.delete(next);
    completed.push(next);
  }

  return { maxRunning, completed, queued: queued.length, running: running.size };
}

export function expandedSyntheticEvents(eventCount: number): CanonicalThreadEvent[] {
  const base = normalizeAllFixtures();
  const out: CanonicalThreadEvent[] = [];
  for (let index = 0; index < eventCount; index++) {
    const source = base[index % base.length]!;
    const cycle = Math.floor(index / base.length);
    const slot = cycle % 20;
    const childId = `${source.identity.provider}:child-${slot + 1}`;
    const sourceSession = source.identity.nativeSessionId;
    const childOwned = sourceSession?.endsWith("-child") ?? false;
    const body = source.kind === "child.started" || source.kind === "child.updated" || source.kind === "child.completed"
      ? { ...source, childId }
      : source;
    out.push({
      ...source,
      ...body,
      eventId: `${source.eventId}:${cycle}`,
      seq: index + 1,
      deliverySeq: index + 1,
      ts: index + 1,
      identity: {
        ...source.identity,
        nativeSessionId: childOwned ? childId : sourceSession,
        nativeEventId: `${source.identity.nativeEventId}:${cycle}`,
      },
    } as CanonicalThreadEvent);
  }
  return out;
}
