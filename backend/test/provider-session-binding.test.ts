import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { providerSessionBinding } from "@useagent/agent-harness/canonical";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import {
  createRun,
  getRun,
  setRunProviderSession,
  setRunSandbox,
} from "../src/runs/repo";
import "./helpers";

test("provider session binding preserves old rows and constrains current authority", async () => {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "session binding",
    model: "claude-haiku-4-5",
    engine: "pi",
    orgId: "org-skynet-dev",
    userId: null,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  expect((await getRun(runId))?.providerSession).toBeNull();

  const binding = providerSessionBinding({
    provider: "pi",
    nativeSessionId: "/sessions/pi.jsonl",
    protocolVersion: "oh-my-pi-rpc/18.0.3",
    runtime: { kind: "sandbox", id: "sandbox-1" },
    capabilities: {} as never,
    generation: 4,
  });
  await setRunSandbox(runId, "sandbox-1");
  await setRunProviderSession(runId, binding);
  expect(await getRun(runId)).toMatchObject({
    engineSessionId: binding.nativeSessionId,
    providerSession: binding,
  });

  await expect(db
    .update(runs)
    .set({ engineSessionId: "another-session" })
    .where(eq(runs.id, runId))
    .execute())
    .rejects.toThrow();

  for (const malformed of [
    {},
    { ...binding, version: "1" },
    { ...binding, authEpoch: undefined },
    { ...binding, generation: 0 },
    { ...binding, runtime: { kind: "sandbox" } },
  ]) {
    await expect(db
      .update(runs)
      .set({ providerSession: malformed as never })
      .where(eq(runs.id, runId))
      .execute())
      .rejects.toThrow();
  }
});
