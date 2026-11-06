import { expect, test } from "bun:test";
import { captureLossForRun } from "../src/runs/capture-loss";
import {
  CaptureFenceError,
  drainProviderEvents,
  providerEventExists,
  recordProviderEvent,
  recordProviderEvents,
  recordProviderEventIfAbsent,
  type ProviderEventInput,
} from "../src/runs/provider-events";
import { getNativeFramesSince, subscribeNative } from "../src/runs/native-events";
import { createRun } from "../src/runs/repo";
import { DEV_ORG_ID, DEV_USER_ID } from "../src/seed";
import "./helpers";
import { PLATFORM_EVENT_LANES } from "@useagent/agent-harness/canonical";

test("root message revisions roll back together and retain their first ordering anchor", async () => {
  const runId = crypto.randomUUID();
  await createRun({ id: runId, prompt: "atomic narration", model: "test-model", engine: "mock",
    orgId: DEV_ORG_ID, userId: DEV_USER_ID, parentRunId: null, threadId: runId });
  const base = { runId, threadId: runId, provider: "t3", nativeSessionId: "root", nativeMessageId: "message" };
  const anchor = { ...base, id: `${runId}:start`, eventType: "t3.message.started", payload: { role: "assistant", turnId: "turn" } };
  const first = { ...base, id: `${runId}:0`, eventType: "t3.message.updated", payload: { text: "before", revision: "before" } };
  await recordProviderEvents([anchor, first], { required: true });
  const prior = await getNativeFramesSince(runId, -1);
  const seen: string[] = [];
  const unsubscribe = subscribeNative(runId, (frame) => seen.push(frame.eventId));
  try {
    await expect(recordProviderEvents([
      anchor, { ...first, payload: { text: "partial", revision: "after" } },
      { ...base, id: `${runId}:1`, eventType: null as never },
    ], { required: true })).rejects.toThrow();
    expect(seen).toEqual([]);
    expect(await getNativeFramesSince(runId, -1)).toEqual(prior);
    await recordProviderEvents([anchor, { ...first, payload: { text: "after", revision: "after" } }], { required: true });
    const next = await getNativeFramesSince(runId, -1);
    expect(next.find((frame) => frame.eventId === anchor.id)?.seq).toBe(prior[0]?.seq);
    expect(seen).toEqual([first.id]);
    expect(next.find((frame) => frame.eventId === first.id)?.payload).toEqual({ text: "after", revision: "after" });
  } finally { unsubscribe(); }
});

test("a sealed run rejects an entire message batch before publishing", async () => {
  const runId = crypto.randomUUID();
  const seen: string[] = [];
  const unsubscribe = subscribeNative(runId, (frame) => seen.push(frame.eventId));
  try {
    await expect(recordProviderEvents([0, 1].map((segment) => ({
      id: `${runId}:${segment}`, runId, threadId: runId, provider: "t3", eventType: "t3.message.updated",
      payload: { text: "must not land", segment },
    })), { fence: async () => false })).rejects.toBeInstanceOf(CaptureFenceError);
    expect(seen).toEqual([]);
    expect(await providerEventExists(`${runId}:0`)).toBe(false);
    expect(await providerEventExists(`${runId}:1`)).toBe(false);
  } finally { unsubscribe(); }
});

test("a stale fence rejects once without recording capture loss", async () => {
  const runId = crypto.randomUUID();
  let fenceCalls = 0;
  await expect(recordProviderEvent({
    id: `${runId}:stale-fence`,
    runId,
    threadId: runId,
    provider: "test",
    eventType: "session.started",
    payload: {},
  }, {
    fence: async () => {
      fenceCalls++;
      return false;
    },
  })).rejects.toBeInstanceOf(CaptureFenceError);
  expect(fenceCalls).toBe(1);
  expect(await captureLossForRun(runId)).toBeNull();
});

test("a fenced invalid write retries as required without recording capture loss", async () => {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "fenced invalid provider event",
    model: "test-model",
    engine: "mock",
    orgId: DEV_ORG_ID,
    userId: DEV_USER_ID,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  let fenceCalls = 0;
  await expect(recordProviderEvent({
    id: `${runId}:invalid-fenced-write`,
    runId,
    threadId: runId,
    provider: "test",
    eventType: null as never,
  }, {
    fence: async () => {
      fenceCalls++;
      return true;
    },
  })).rejects.toThrow();
  expect(fenceCalls).toBe(3);
  expect(await captureLossForRun(runId)).toBeNull();
});

test("required provider events propagate failure without poisoning the run sequencer", async () => {
  const runId = crypto.randomUUID();
  const input: ProviderEventInput = {
    id: `${runId}:session`,
    runId,
    threadId: runId,
    provider: "test",
    eventType: "session.started",
    payload: { capabilities: {} },
  };

  await expect(recordProviderEvent(input, { critical: true, required: true })).rejects.toThrow();

  await createRun({
    id: runId,
    prompt: "provider event retry",
    model: "test-model",
    engine: "mock",
    orgId: DEV_ORG_ID,
    userId: DEV_USER_ID,
    parentRunId: null,
    threadId: runId,
  });
  await expect(recordProviderEvent(input, { critical: true, required: true })).resolves.toBeUndefined();
  expect(await providerEventExists(input.id)).toBe(true);
});

test("a capture that fails transiently is retried inside the run's chain and is not counted as lost", async () => {
  const runId = crypto.randomUUID();
  const input: ProviderEventInput = {
    id: `${runId}:late-run`,
    runId,
    threadId: runId,
    provider: "test",
    eventType: "session.started",
    payload: {},
  };
  // The run does not exist yet, so the first attempt fails its foreign key; the run is
  // created inside the retry window and the retry lands the frame.
  const capture = recordProviderEvent(input);
  await new Promise((r) => setTimeout(r, 30));
  expect(await providerEventExists(input.id)).toBe(false); // the first attempt failed
  await createRun({
    id: runId,
    prompt: "late run",
    model: "test-model",
    engine: "mock",
    orgId: DEV_ORG_ID,
    userId: DEV_USER_ID,
    parentRunId: null,
    threadId: runId,
  });
  await capture;
  expect(await providerEventExists(input.id)).toBe(true);
  expect(await captureLossForRun(runId)).toBeNull();
});

test("a capture that fails every retry is counted as a lost frame for its run", async () => {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "lost frame",
    model: "test-model",
    engine: "mock",
    orgId: DEV_ORG_ID,
    userId: DEV_USER_ID,
    parentRunId: null,
    threadId: runId,
  });
  await recordProviderEvent({
    id: `${runId}:bad`,
    runId,
    threadId: runId,
    provider: "test",
    eventType: null as never,
  });
  expect(await captureLossForRun(runId)).toEqual({ lostFrames: 1, lastError: expect.any(String) });
});

test("immutable provider events fail required, repair on retry, and publish only once", async () => {
  const runId = crypto.randomUUID();
  const input: ProviderEventInput = {
    id: `${runId}:artifact.created`,
    runId,
    threadId: runId,
    provider: PLATFORM_EVENT_LANES.platform,
    eventType: "artifact.created",
    payload: { revision: 1 },
  };

  await expect(recordProviderEventIfAbsent(input)).rejects.toThrow();

  await createRun({
    id: runId,
    prompt: "immutable provider event retry",
    model: "test-model",
    engine: "mock",
    orgId: DEV_ORG_ID,
    userId: DEV_USER_ID,
    parentRunId: null,
    threadId: runId,
  });
  const seen: string[] = [];
  const unsubscribe = subscribeNative(runId, (frame) => seen.push(frame.eventId));

  try {
    const results = await Promise.all([
      recordProviderEventIfAbsent(input),
      recordProviderEventIfAbsent({ ...input, payload: { revision: 2 } }),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await providerEventExists(input.id)).toBe(true);
    expect(seen).toEqual([input.id]);
    const durable = await getNativeFramesSince(runId, -1);
    expect(durable).toHaveLength(1);
    expect(durable[0]?.payload).toEqual({ revision: 1 });
  } finally {
    unsubscribe();
  }
});

test("an aborted immutable event queued behind an earlier event never writes later", async () => {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "aborted queued immutable event",
    model: "test-model",
    engine: "mock",
    orgId: DEV_ORG_ID,
    userId: DEV_USER_ID,
    parentRunId: null,
    threadId: runId,
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocking = recordProviderEvent({
    id: `${runId}:blocking`,
    runId,
    threadId: runId,
    provider: "test",
    eventType: "session.started",
    payload: {},
  }, {
    fence: async () => {
      markStarted();
      await released;
      return true;
    },
  });
  await started;

  const controller = new AbortController();
  let fenceCalls = 0;
  const eventId = `${runId}:artifact.created`;
  const queued = recordProviderEventIfAbsent({
    id: eventId,
    runId,
    threadId: runId,
    provider: PLATFORM_EVENT_LANES.platform,
    eventType: "artifact.created",
    payload: {},
  }, {
    signal: controller.signal,
    beforeCommit: async () => { fenceCalls++; },
  });
  controller.abort(new Error("publication deadline"));
  await expect(queued).rejects.toThrow("publication deadline");

  release();
  await blocking;
  await drainProviderEvents(runId);
  expect(fenceCalls).toBe(0);
  expect(await providerEventExists(eventId)).toBe(false);
});

test("a valid immutable event fence records and publishes the event once", async () => {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "valid immutable event fence",
    model: "test-model",
    engine: "mock",
    orgId: DEV_ORG_ID,
    userId: DEV_USER_ID,
    parentRunId: null,
    threadId: runId,
  });
  const eventId = `${runId}:artifact.revised`;
  const input: ProviderEventInput = {
    id: eventId,
    runId,
    threadId: runId,
    provider: PLATFORM_EVENT_LANES.platform,
    eventType: "artifact.revised",
    payload: { revision: 1 },
  };
  const seen: string[] = [];
  const unsubscribe = subscribeNative(runId, (frame) => seen.push(frame.eventId));
  let fenceCalls = 0;
  const beforeCommit = async () => { fenceCalls++; };

  try {
    const results = await Promise.all([
      recordProviderEventIfAbsent(input, { beforeCommit }),
      recordProviderEventIfAbsent(input, { beforeCommit }),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(fenceCalls).toBe(2);
    expect(await providerEventExists(eventId)).toBe(true);
    expect(seen).toEqual([eventId]);
  } finally {
    unsubscribe();
  }
});

test("shadow graph failure cannot block required provider persistence or native publication", async () => {
  const previousMode = process.env.EXECUTION_GRAPH_ROLLOUT;
  process.env.EXECUTION_GRAPH_ROLLOUT = "shadow";
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "shadow writer failure isolation",
    model: "test-model",
    engine: "mock",
    orgId: DEV_ORG_ID,
    userId: DEV_USER_ID,
    parentRunId: null,
    threadId: runId,
  });
  const seen: string[] = [];
  const unsubscribe = subscribeNative(runId, (frame) => seen.push(frame.eventId));
  const first: ProviderEventInput = {
    id: `${runId}:session:first`,
    runId,
    threadId: runId,
    provider: "t3",
    eventType: "session.started",
    nativeSessionId: "root-one",
    payload: { capabilities: {} },
  };
  const conflicting: ProviderEventInput = {
    ...first,
    id: `${runId}:session:conflicting`,
    nativeSessionId: "root-two",
  };

  try {
    await recordProviderEvent(first, { critical: true, required: true });
    await expect(
      recordProviderEvent(conflicting, { critical: true, required: true }),
    ).resolves.toBeUndefined();
    expect(await providerEventExists(conflicting.id)).toBe(true);
    expect(seen).toContain(conflicting.id);
  } finally {
    unsubscribe();
    if (previousMode === undefined) delete process.env.EXECUTION_GRAPH_ROLLOUT;
    else process.env.EXECUTION_GRAPH_ROLLOUT = previousMode;
  }
});
