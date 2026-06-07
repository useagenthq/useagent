import { expect, test } from "bun:test";
import {
  providerEventExists,
  recordProviderEvent,
  type ProviderEventInput,
} from "../src/runs/provider-events";
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
