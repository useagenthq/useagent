import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildExecutionCapabilitySnapshot } from "../src/engines/execution-capabilities";
import { composeRunTurnPrompt, type EngineRunContext } from "../src/engines/types";
import { createRun, getRun, setRunEngineSession } from "../src/runs/repo";
import { liveActorRunIds, RUNS_ROOT, spawnWorker } from "../src/worker";
import { DEV_ORG_ID } from "../src/dev-org";

// The worker starts the engine adapter while the turn's prompt-only context is
// still being gathered; the adapter awaits it just before composing the prompt.
// The adapter, its dispatch gate, the bot lookup and memory recall are replaced
// at their module boundary so the ordering can be observed without a sandbox.

const engines = { ...(await import("../src/engines")) };
const login = { ...(await import("../src/engines/sandbox-login")) };
const bots = { ...(await import("../src/bots/prompt-context")) };
const memory = { ...(await import("../src/memory/team-memory")) };

const ORG_ID = DEV_ORG_ID;
const EXECUTION = buildExecutionCapabilitySnapshot({
  runtime: "sandbox",
  workspaceRoot: "/work",
  gatewayAvailable: true,
  desktopAvailability: "on_demand",
});

type Adapter = (ctx: EngineRunContext) => Promise<void>;
let adapter: Adapter = async () => {};
let botContext: () => Promise<{ identity: string; delegation: string }> = async () => ({ identity: "", delegation: "" });
const recalledPrompts: string[] = [];
const threads: string[] = [];

beforeAll(() => {
  mock.module("../src/engines", () => ({
    ...engines,
    runProviderTurn: async (_provider: string, ctx: EngineRunContext) => {
      await adapter(ctx);
      return true;
    },
  }));
  mock.module("../src/engines/sandbox-login", () => ({ ...login, dispatchReadyForUser: async () => true }));
  mock.module("../src/bots/prompt-context", () => ({ ...bots, botContextForTurn: () => botContext() }));
  mock.module("../src/memory/team-memory", () => ({
    ...memory,
    recallScopedMemory: async (prompt: string) => {
      recalledPrompts.push(prompt);
      return { rendered: "", items: [], truncated: false, latencyMs: 0, degraded: false };
    },
  }));
});

afterAll(async () => {
  mock.module("../src/engines", () => engines);
  mock.module("../src/engines/sandbox-login", () => login);
  mock.module("../src/bots/prompt-context", () => bots);
  mock.module("../src/memory/team-memory", () => memory);
  await Promise.all(threads.map((threadId) => rm(join(RUNS_ROOT, threadId), { recursive: true, force: true })));
});

afterEach(() => {
  delete process.env.MEMORY_API_URL;
  recalledPrompts.length = 0;
});

async function runTurn(input: { prompt: string; threadId?: string; parentRunId?: string | null }): Promise<string> {
  const id = crypto.randomUUID();
  const threadId = input.threadId ?? id;
  threads.push(threadId);
  await createRun({
    id,
    prompt: input.prompt,
    model: "test-model",
    engine: "opencode",
    orgId: ORG_ID,
    userId: null,
    parentRunId: input.parentRunId ?? null,
    threadId,
    repos: [],
    memoryScope: "org",
  });
  spawnWorker(id);
  const deadline = Date.now() + 10_000;
  while (liveActorRunIds().includes(id)) {
    if (Date.now() > deadline) throw new Error("the turn never settled");
    await Bun.sleep(10);
  }
  return id;
}

/** A turn the fake adapter completes after composing its prompt the way the
 *  real adapters do, once the sandbox would be ready. */
function completingAdapter(resumed: boolean, onStart: () => void = () => {}): { prompt: () => string; ctx: () => EngineRunContext } {
  let composed = "";
  let seen: EngineRunContext | null = null;
  adapter = async (ctx) => {
    seen = ctx;
    onStart();
    composed = await composeRunTurnPrompt(ctx, resumed, EXECUTION);
    await ctx.markPromptDelivered?.();
    ctx.setSummary("done", 1);
  };
  return { prompt: () => composed, ctx: () => seen! };
}

describe("turn context overlaps sandbox preparation", () => {
  test("the adapter starts while the context is still being gathered and composes with it", async () => {
    const sandboxAcquired = Promise.withResolvers<void>();
    // The context cannot finish until the adapter has started: a worker that
    // gathered it before starting the engine would never settle this turn.
    botContext = async () => {
      await sandboxAcquired.promise;
      return { identity: "BOT_IDENTITY\n", delegation: "" };
    };
    let pendingAtStart = false;
    const turn = completingAdapter(false, () => {
      pendingAtStart = turn.ctx().turnContext === "";
      sandboxAcquired.resolve();
    });

    const runId = await runTurn({ prompt: "inspect the repository" });

    expect(pendingAtStart).toBe(true);
    expect(turn.prompt()).toContain("BOT_IDENTITY\n");
    const run = await getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.preambleHashes).toEqual(turn.ctx().deliveredPreamble!);
  });

  test("a context failure fails the run as the worker error it was before the overlap", async () => {
    botContext = async () => {
      throw new Error("bot roster unavailable");
    };
    completingAdapter(false);

    const run = await getRun(await runTurn({ prompt: "inspect the repository" }));

    expect(run?.status).toBe("failed");
    expect(run?.summary).toBe("worker error: bot roster unavailable");
  });
});

describe("resumed preamble and recall on follow-ups", () => {
  test("a resumed follow-up skips the rule blocks its session holds; a short acknowledgement skips recall", async () => {
    process.env.MEMORY_API_URL = "http://memory.invalid";
    botContext = async () => ({ identity: "", delegation: "" });
    const first = completingAdapter(false);
    const rootId = await runTurn({ prompt: "deploy the billing service" });
    expect(first.prompt()).toContain("<workflow_routing>");
    expect(recalledPrompts).toEqual(["deploy the billing service"]);
    await setRunEngineSession(rootId, "ses-1");

    const ack = completingAdapter(true);
    const ackId = await runTurn({ prompt: "ok thanks", threadId: rootId, parentRunId: rootId });
    expect(ack.ctx().priorPreamble).toEqual((await getRun(rootId))?.preambleHashes ?? null);
    expect(ack.prompt()).not.toContain("<workflow_routing>");
    expect(ack.prompt()).toContain("<current_user_request>\nok thanks\n</current_user_request>");
    expect(recalledPrompts).toEqual(["deploy the billing service"]);
    await setRunEngineSession(ackId, "ses-1");

    completingAdapter(true);
    await runTurn({ prompt: "what changed?", threadId: rootId, parentRunId: ackId });
    expect(recalledPrompts).toEqual(["deploy the billing service", "what changed?"]);
  });
});
