// Protocol 2 fixtures built from the runtime contract (upstream ce90eec1f,
// packages/contracts/src/orchestrationV2.ts) and checked on 2026-10-03 against
// frames recorded from runtime dd2b1389590f with Codex and OpenCode 2: every
// field the driver reads matches. Claude, file changes, plans, errors and
// compaction were not yet seen live.
import { describe, expect, test } from "bun:test";
import { createSecretRedactor } from "../secrets/redact";
import { makeNativeFrame } from "../runs/native-events";
import type { ProviderEventInput } from "../runs/provider-events";
import { providerPayloadCapBytes, CHILD_TRANSCRIPT_PAYLOAD_CAP_BYTES } from "../runs/provider-events";
import type { SandboxHandle } from "../sandboxes/provider";
import { translateOpenCode } from "./opencode-canonical";
import { createChildThreadFollower } from "./runtime-child-threads";
import type { FollowRuntimeThreadInput } from "./runtime-event-stream";
import { runtimeActivityProviderEvent, shouldProjectRuntimeActivity } from "./runtime-orchestration";
import { runtimeChildThreadActivities, runtimeThreadView } from "./runtime-v2-view";
import { v2Item, v2Message, v2Projection, v2Snapshot } from "./runtime-v2.test-support";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

const PARENT = `${SANDBOX_NAME_PREFIX}-thread-thread-1`;
const CHILD = "child-thread-1";
/** The subagent's record id: its child id from its first revision on. */
const SUBAGENT = "sa-1";
const ctx = { runId: "run-1", threadId: "thread-1" };
const redact = createSecretRedactor([]);

const child = (overrides: Parameters<typeof v2Projection>[0] = {}) => v2Snapshot(5, v2Projection(overrides, CHILD));
const subagent = (status: string, childThreadId: string | null = CHILD) => v2Snapshot(4, v2Projection({
  subagents: [{ id: SUBAGENT, runId: "r1", childThreadId, status, prompt: "look around", title: "Explorer", result: null, updatedAt: "x" }],
  turnItems: [v2Item({ id: "si-1", type: "subagent", runId: "r1", status, subagentId: SUBAGENT, childThreadId, prompt: "look around" })],
}));

/** The ledger rows a list of activities becomes, as frames the canonical translator reads. */
function frames(events: readonly ProviderEventInput[]) {
  return events.map((event, seq) => makeNativeFrame({
    eventId: event.id, seq, provider: event.provider, eventType: event.eventType,
    sessionId: event.nativeSessionId ?? null, parentSessionId: event.nativeParentSessionId ?? null,
    messageId: event.nativeMessageId ?? null, partId: event.nativePartId ?? null, callId: event.nativeCallId ?? null,
    payloadText: JSON.stringify(event.payload),
  }));
}

describe("subagent threads", () => {
  test("a subagent opens its execution with a start, then reports its phase", () => {
    const running = runtimeThreadView(subagent("running")).thread.activities;
    expect(running.map((activity) => activity.kind)).toEqual(["task.started", "task.progress"]);
    const started = runtimeActivityProviderEvent(ctx, PARENT, running[0]!, redact);
    expect(started).toMatchObject({
      eventType: "t3.activity.task.started", nativeSessionId: SUBAGENT, nativeParentSessionId: PARENT, nativeCallId: SUBAGENT,
    });
    const done = runtimeThreadView(subagent("interrupted")).thread.activities;
    expect(done[1]).toMatchObject({ kind: "task.completed", payload: { status: "cancelled", v2: expect.objectContaining({ type: "subagent", status: "interrupted" }) } });
  });

  test("a subagent keeps its identity when its own thread appears on a later revision", () => {
    // Recorded live: a subagent's first revisions carry no child thread yet.
    const identity = (snapshot: ReturnType<typeof subagent>) => runtimeThreadView(snapshot).thread.activities
      .map((activity) => runtimeActivityProviderEvent(ctx, PARENT, activity, redact))
      .map((event) => [event.id, event.nativeSessionId, event.nativeCallId]);
    const before = identity(subagent("running", null));
    expect(before[0]).toEqual([expect.stringContaining("si-1:started"), SUBAGENT, SUBAGENT]);
    expect(identity(subagent("running"))).toEqual(before);
  });

  test("a child's tools and messages are owned by the child and stay off the parent's step timeline", () => {
    const activities = runtimeChildThreadActivities(child({
      turnItems: [v2Item({ id: "c-tool", type: "command_execution", status: "completed", input: "ls" })],
      messages: [v2Message({ id: "c-msg", text: "Found it", streaming: false }), v2Message({ id: "c-user", role: "user", text: "look around" })],
    }), PARENT, SUBAGENT);
    expect(activities.map((activity) => activity.kind)).toEqual(["tool.completed", "child.message.completed"]);
    for (const activity of activities) {
      expect(shouldProjectRuntimeActivity(activity, activities)).toBe(false);
      const event = runtimeActivityProviderEvent(ctx, PARENT, activity, redact);
      expect(event).toMatchObject({ nativeSessionId: SUBAGENT, nativeParentSessionId: PARENT });
    }
    const message = runtimeActivityProviderEvent(ctx, PARENT, activities[1]!, redact);
    expect(message).toMatchObject({ eventType: "t3.activity.child.message.completed", nativeMessageId: "c-msg" });
    expect(providerPayloadCapBytes(message)).toBe(CHILD_TRANSCRIPT_PAYLOAD_CAP_BYTES);
  });

  test("the canonical lane shows the child, its tool and its message under the child's identity", () => {
    const parentEvents = runtimeThreadView(subagent("running")).thread.activities
      .map((activity) => runtimeActivityProviderEvent(ctx, PARENT, activity, redact));
    const childEvents = runtimeChildThreadActivities(child({
      turnItems: [v2Item({ id: "c-tool", type: "command_execution", status: "completed", input: "ls" })],
      messages: [v2Message({ id: "c-msg", text: "Found it" })],
    }), PARENT, SUBAGENT).map((activity) => runtimeActivityProviderEvent(ctx, PARENT, activity, redact));
    const canonical = translateOpenCode(frames([...parentEvents, ...childEvents]), { ...ctx, engine: "claude" }).events;
    expect(canonical.filter((event) => event.kind === "child.started")).toEqual([
      expect.objectContaining({ childId: SUBAGENT, identity: expect.objectContaining({ nativeSessionId: SUBAGENT, nativeParentSessionId: PARENT }) }),
    ]);
    expect(canonical.find((event) => event.kind === "tool.completed")).toMatchObject({
      toolCallId: "c-tool", identity: { nativeSessionId: SUBAGENT },
    });
    expect(canonical.find((event) => event.kind === "message.delta")).toMatchObject({
      messageId: "c-msg", text: "Found it", identity: { nativeSessionId: SUBAGENT },
    });
  });

  test("follows each named child once, records what changed, and stops with the turn", async () => {
    const followed: FollowRuntimeThreadInput[] = [];
    const recorded: ProviderEventInput[] = [];
    const follower = createChildThreadFollower({
      ctx, sandbox: {} as SandboxHandle, parentThreadId: PARENT, redact, signal: new AbortController().signal,
      dependencies: {
        follow: async (input) => {
          followed.push(input);
          const state = child({ messages: [v2Message({ id: "c-msg", text: "Working" })] });
          await input.applySnapshot(runtimeThreadView(state), state);
          await input.applySnapshot(runtimeThreadView(state), state);
          await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        },
        record: async (event) => { recorded.push(event); },
      },
    });
    follower.observe(subagent("running").projection);
    follower.observe(subagent("running").projection);
    await Bun.sleep(0);
    expect(followed.map((input) => input.threadId)).toEqual([CHILD]);
    expect(recorded.map((event) => event.eventType)).toEqual(["t3.activity.child.message.completed"]);
    await follower.close();
    expect(followed[0]!.signal.aborted).toBe(true);
    follower.observe(subagent("running").projection);
    expect(followed).toHaveLength(1);
  });

  test("a child that fails never fails the turn, and closing never waits on a stuck child", async () => {
    const follower = createChildThreadFollower({
      ctx, sandbox: {} as SandboxHandle, parentThreadId: PARENT, redact, signal: new AbortController().signal,
      dependencies: {
        follow: async () => { await new Promise(() => {}); },
        record: async () => {},
      },
    });
    follower.observe(subagent("running").projection);
    const started = performance.now();
    await follower.close();
    expect(performance.now() - started).toBeLessThan(3_000);

    const failing = createChildThreadFollower({
      ctx, sandbox: {} as SandboxHandle, parentThreadId: PARENT, redact, signal: new AbortController().signal,
      dependencies: { follow: async () => { throw new Error("socket refused"); }, record: async () => {} },
    });
    failing.observe(subagent("running").projection);
    await failing.close();
  });
});
