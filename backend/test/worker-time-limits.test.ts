import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { EngineRunContext } from "../src/engines/types";
import { createRun, getRun, getStepsApi } from "../src/runs/repo";
import { liveActorRunIds, RUNS_ROOT, spawnWorker } from "../src/worker";
import { DEV_ORG_ID } from "../src/dev-org";

// ENGINE_TIMEOUT_MS (silence) and ENGINE_MAX_MS (ceiling) abort a real worker
// turn through its own timers; the done step and the run summary must name the
// limit that fired. The adapter and its dispatch gate are replaced at their
// module boundary so a turn can hang without a sandbox.

const engines = { ...(await import("../src/engines")) };
const login = { ...(await import("../src/engines/sandbox-login")) };
const bots = { ...(await import("../src/bots/prompt-context")) };

const previousSilence = process.env.ENGINE_TIMEOUT_MS;
const previousCeiling = process.env.ENGINE_MAX_MS;

type Adapter = (ctx: EngineRunContext) => Promise<void>;
let adapter: Adapter = async () => {};
const threads: string[] = [];

/** Never finishes on its own: waits for the worker to abort the turn. */
function hangUntilAborted(ctx: EngineRunContext, heartbeatMs: number | null = null): Promise<void> {
  return new Promise((_, reject) => {
    if (ctx.signal.aborted) {
      reject(new Error("turn aborted"));
      return;
    }
    const heartbeat = heartbeatMs === null ? null : setInterval(() => ctx.reportActivity?.(), heartbeatMs);
    ctx.signal.addEventListener("abort", () => {
      if (heartbeat) clearInterval(heartbeat);
      reject(new Error("turn aborted"));
    }, { once: true });
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  mock.module("../src/engines", () => ({
    ...engines,
    runProviderTurn: async (_provider: string, ctx: EngineRunContext) => {
      await adapter(ctx);
      return true;
    },
  }));
  mock.module("../src/engines/sandbox-login", () => ({ ...login, dispatchReadyForUser: async () => true }));
  mock.module("../src/bots/prompt-context", () => ({
    ...bots,
    botContextForTurn: async () => ({ identity: "", delegation: "" }),
  }));
});

afterEach(() => {
  restoreEnv("ENGINE_TIMEOUT_MS", previousSilence);
  restoreEnv("ENGINE_MAX_MS", previousCeiling);
});

afterAll(async () => {
  mock.module("../src/engines", () => engines);
  mock.module("../src/engines/sandbox-login", () => login);
  mock.module("../src/bots/prompt-context", () => bots);
  await Promise.all(threads.map((threadId) => rm(join(RUNS_ROOT, threadId), { recursive: true, force: true })));
});

async function runTurn(): Promise<{ summary: string | null; status: string | undefined; doneLabel: string | undefined }> {
  const id = crypto.randomUUID();
  threads.push(id);
  await createRun({
    id,
    prompt: "inspect the repository",
    model: "test-model",
    engine: "opencode",
    orgId: DEV_ORG_ID,
    userId: null,
    parentRunId: null,
    threadId: id,
    repos: [],
    memoryScope: "org",
  });
  spawnWorker(id);
  const deadline = Date.now() + 10_000;
  while (liveActorRunIds().includes(id)) {
    if (Date.now() > deadline) throw new Error("the turn never settled");
    await Bun.sleep(10);
  }
  const run = await getRun(id);
  const done = (await getStepsApi(id)).findLast((step) => step.kind === "done");
  return { summary: run?.summary ?? null, status: run?.status, doneLabel: done?.label };
}

describe("turn time limits name the limit that fired", () => {
  test("only ENGINE_MAX_MS set: the ceiling's time, never Infinity", async () => {
    delete process.env.ENGINE_TIMEOUT_MS;
    process.env.ENGINE_MAX_MS = "150";
    adapter = (ctx) => hangUntilAborted(ctx);

    expect(await runTurn()).toEqual({
      status: "failed",
      summary: "timed out after 0.15s",
      doneLabel: "Timed out after 0.15s",
    });
  });

  test("both set, a silent turn: the silence window's time", async () => {
    process.env.ENGINE_TIMEOUT_MS = "120";
    process.env.ENGINE_MAX_MS = "5000";
    adapter = (ctx) => hangUntilAborted(ctx);

    expect(await runTurn()).toEqual({
      status: "failed",
      summary: "timed out after 0.12s",
      doneLabel: "Timed out after 0.12s",
    });
  });

  test("both set, a busy turn: the ceiling's time, not the silence window's", async () => {
    process.env.ENGINE_TIMEOUT_MS = "2000";
    process.env.ENGINE_MAX_MS = "250";
    adapter = (ctx) => hangUntilAborted(ctx, 20);

    expect(await runTurn()).toEqual({
      status: "failed",
      summary: "timed out after 0.25s",
      doneLabel: "Timed out after 0.25s",
    });
  });

  test("a setting past the timer maximum does not end the turn at once", async () => {
    delete process.env.ENGINE_TIMEOUT_MS;
    process.env.ENGINE_MAX_MS = "3000000000";
    adapter = async (ctx) => {
      await Bun.sleep(100);
      if (ctx.signal.aborted) throw new Error("aborted early");
      ctx.setSummary("done", 1);
    };

    const result = await runTurn();
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("done");
  });
});
