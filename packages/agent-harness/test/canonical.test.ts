// Locks the canonical event vocabulary. The exhaustive
// switch is a COMPILE-TIME guard: add a variant to CanonicalEventBody without a
// case here and `assertNeverEvent` fails to typecheck. That is the point - every
// harness translator and every React consumer can rely on the union being total.

import { describe, expect, test } from "bun:test";
import {
  assertNeverEvent,
  CANONICAL_SCHEMA_VERSION,
  type CanonicalAgentEvent,
  type CanonicalEventBody,
  type CanonicalEventKind,
  toolServerDisplayName,
} from "../src/canonical";

/** A human label per kind, written via an exhaustive switch. If a new kind is
 *  added to the union and not handled here, this file fails to compile. */
function describeKind(e: CanonicalEventBody): string {
  switch (e.kind) {
    case "session.started": return "session started";
    case "session.metadata": return "session metadata";
    case "turn.started": return "turn started";
    case "turn.completed": return "turn completed";
    case "message.started": return "message started";
    case "message.delta": return "message delta";
    case "message.completed": return "message completed";
    case "reasoning.delta": return "reasoning delta";
    case "reasoning.completed": return "reasoning completed";
    case "plan.updated": return "plan updated";
    case "tool.started": return "tool started";
    case "tool.progress": return "tool progress";
    case "tool.completed": return "tool completed";
    case "file.changed": return "file changed";
    case "artifact.created": return "artifact created";
    case "artifact.delivered": return "artifact delivered";
    case "terminal.output": return "terminal output";
    case "child.started": return "child started";
    case "child.updated": return "child updated";
    case "child.completed": return "child completed";
    case "delegation.control": return "delegation control";
    case "approval.requested": return "approval requested";
    case "approval.resolved": return "approval resolved";
    case "question.requested": return "question requested";
    case "question.resolved": return "question resolved";
    case "commands.updated": return "commands updated";
    case "mode.updated": return "mode updated";
    case "usage.updated": return "usage updated";
    case "context.marker": return "context marker";
    case "harness.warning": return "harness warning";
    case "harness.error": return "harness error";
    default:
      return assertNeverEvent(e);
  }
}

const base = (kind: CanonicalEventKind) => ({
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  eventId: `evt_${kind}`,
  seq: 1,
  runId: "run_1",
  threadId: "thr_1",
  ts: 1,
  identity: { provider: "opencode" as const },
});

describe("canonical event vocabulary", () => {
  test("keeps protocol ids internal while presenting the product name", () => {
    expect(toolServerDisplayName("skynet-knowledge")).toBe("useAgent");
    expect(toolServerDisplayName("github")).toBe("github");
  });

  test("exhaustive kind handling (compile-time + runtime)", () => {
    // A representative sample across the discriminant space - each exercises the
    // switch and proves the envelope+body intersection composes.
    const samples: CanonicalAgentEvent[] = [
      { ...base("turn.started"), kind: "turn.started" },
      { ...base("message.delta"), kind: "message.delta", messageId: "m1", text: "hi" },
      { ...base("tool.completed"), kind: "tool.completed", toolCallId: "t1", status: "ok" },
      {
        ...base("artifact.created"),
        kind: "artifact.created",
        name: "report.pdf",
        artifact: { artifactId: "a1", bytes: 42, sha256: "a".repeat(64), contentType: "application/pdf" },
      },
      { ...base("child.started"), kind: "child.started", childId: "c1" },
      {
        ...base("delegation.control"),
        kind: "delegation.control",
        delegationKind: "wait",
        toolCallId: "t-wait",
        targetChildIds: ["c1"],
        status: "ok",
      },
      { ...base("usage.updated"), kind: "usage.updated", outputTokens: 42 },
      { ...base("harness.error"), kind: "harness.error", message: "boom", fatal: true },
    ];
    for (const e of samples) expect(describeKind(e).length).toBeGreaterThan(0);
  });

  test("schema version is pinned", () => {
    expect(CANONICAL_SCHEMA_VERSION).toBe(1);
  });

  test("assertNeverEvent throws if an unknown kind slips through at runtime", () => {
    // Simulate a translator emitting a kind the switch doesn't know (cast past the
    // type system). Fail loud, never silently drop.
    expect(() => describeKind({ kind: "totally.new" } as unknown as CanonicalEventBody)).toThrow(
      /unhandled canonical event kind/,
    );
  });
});
