import { expect, test } from "bun:test";
import {
  providerEventExists,
  recordProviderEvent,
  recordProviderEventIfAbsent,
  type ProviderEventInput,
} from "../src/runs/provider-events";
import { getNativeFramesSince, subscribeNative } from "../src/runs/native-events";
import { createRun } from "../src/runs/repo";
import { DEV_ORG_ID, DEV_USER_ID } from "../src/seed";
import "./helpers";

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

test("immutable provider events fail required, repair on retry, and publish only once", async () => {
  const runId = crypto.randomUUID();
  const input: ProviderEventInput = {
    id: `${runId}:artifact.created`,
    runId,
    threadId: runId,
    provider: "skynet",
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
