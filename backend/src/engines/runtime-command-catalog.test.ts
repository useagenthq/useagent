import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalCommand } from "@useagent/agent-harness/canonical";
import type { recordSessionCommandCatalog, SessionCommandCatalogRow } from "../runs/session-command-catalog";
import {
  buildRuntimeCommandCatalogProbeCommand,
  parseRuntimeCommandCatalog,
  recordRuntimeCommandCatalog,
  runtimeCommandDispatchRejection,
  runtimeCommandCatalogCachePath,
} from "./runtime-command-catalog";
import { PROVIDER_INSTANCE, type RuntimeEngineId } from "./runtime-orchestration";
import { SANDBOX_NAME_PREFIX, SANDBOX_STATE_DIR, SANDBOX_STATE_HOME } from "../sandboxes/sandbox-names";

// Recorded from the pinned native runtime (source commit 90dc3ebbb74b) booted
// locally with an isolated home: the identity and command fields of the status
// cache it wrote for each provider instance, exactly as the probe prints them.
const FIXTURES = new URL("../../test/fixtures/runtime-command-catalog/", import.meta.url);
const ENGINES: readonly RuntimeEngineId[] = ["codex", "claude", "opencode"];
const recorded = (engine: RuntimeEngineId): string =>
  readFileSync(new URL(`${PROVIDER_INSTANCE[engine]}.json`, FIXTURES), "utf8");

/** A sandbox whose shell is this machine's `sh`, with the runtime home under a
 *  temporary HOME so the probe reads the cache through its real path. */
function sandboxWithCaches(caches: Partial<Record<RuntimeEngineId, string>>) {
  const home = mkdtempSync(join(tmpdir(), "runtime-command-catalog-"));
  const cacheDir = join(home, `${SANDBOX_STATE_DIR}/t3/caches`);
  mkdirSync(cacheDir, { recursive: true });
  const writeCache = (engine: RuntimeEngineId, body: string): void => {
    writeFileSync(join(cacheDir, `${PROVIDER_INSTANCE[engine]}.json`), body);
  };
  for (const [engine, body] of Object.entries(caches)) writeCache(engine as RuntimeEngineId, body);
  const executed: string[] = [];
  return {
    executed,
    writeCache,
    process: {
      async executeCommand(command: string) {
        executed.push(command);
        const proc = Bun.spawnSync(["sh", "-c", command], { env: { ...process.env, HOME: home } });
        return { exitCode: proc.exitCode, result: proc.stdout.toString() };
      },
    },
  };
}

/** A recording store: by default the row commits; "rejects" is a write that failed
 *  or hit its statement timeout; "stalls" never answers (a connection that stops
 *  receiving responses). The real write is exercised by the database test. */
function recorder(outcome: "resolves" | "rejects" | "stalls" = "resolves") {
  const calls: { row: SessionCommandCatalogRow; timeoutMs: number | undefined }[] = [];
  const record: typeof recordSessionCommandCatalog = (row, timeoutMs) => {
    calls.push({ row, timeoutMs });
    if (outcome === "rejects") return Promise.reject(new Error("canceling statement due to statement timeout"));
    if (outcome === "stalls") return new Promise<void>(() => {});
    return Promise.resolve();
  };
  return { calls, record };
}

/** A transport whose response never settles (a stalled body), the shape a
 *  sandbox request path can produce. */
const stalled = { process: { executeCommand: () => new Promise<never>(() => {}) } };
const settles = (operation: Promise<unknown>, withinMs: number) =>
  Promise.race([operation.then(() => "settled"), Bun.sleep(withinMs).then(() => "still pending")]);

const ctx = { runId: "run-1", threadId: "thread-1", signal: new AbortController().signal };
const session = { nativeSessionId: `${SANDBOX_NAME_PREFIX}-thread-thread-1` };
const COMPACT = "Summarize the conversation and reduce context usage";

describe("runtime command catalog: the runtime's status cache becomes the session's recorded catalog", () => {
  test("the probe reads each engine's per-instance status cache through the runtime home", async () => {
    expect(runtimeCommandCatalogCachePath("claude")).toBe(`${SANDBOX_STATE_HOME}/t3/caches/claudeAgent.json`);
    expect(runtimeCommandCatalogCachePath("codex")).toBe(`${SANDBOX_STATE_HOME}/t3/caches/codex.json`);
    expect(runtimeCommandCatalogCachePath("opencode")).toBe(`${SANDBOX_STATE_HOME}/t3/caches/opencode.json`);
    const sandbox = sandboxWithCaches({ codex: recorded("codex"), claude: recorded("claude"), opencode: recorded("opencode") });
    for (const engine of ENGINES) {
      const probe = await sandbox.process.executeCommand(buildRuntimeCommandCatalogProbeCommand(engine));
      expect(probe.exitCode).toBe(0);
      const printed = JSON.parse(probe.result) as Record<string, unknown>;
      // Identity and commands only: models, usage and auth stay in the sandbox.
      expect(Object.keys(printed).toSorted()).toEqual(["checkedAt", "driver", "instanceId", "slashCommands"]);
      expect(printed.instanceId).toBe(PROVIDER_INSTANCE[engine]);
    }
  });

  test("each recorded catalog normalizes to the wire shape the composer reads", () => {
    expect(parseRuntimeCommandCatalog(recorded("codex"), "codex")?.commands).toEqual([
      { name: "compact", description: COMPACT },
      { name: "feedback", description: "Send this thread and Codex logs to OpenAI", input: "Describe the issue (optional)" },
    ]);
    expect(parseRuntimeCommandCatalog(recorded("opencode"), "opencode")?.commands).toEqual([
      { name: "compact", description: COMPACT },
    ]);
    const claude = parseRuntimeCommandCatalog(recorded("claude"), "claude");
    expect(claude?.checkedAt).toBe((JSON.parse(recorded("claude")) as { checkedAt: string }).checkedAt);
    expect(claude?.commands).toHaveLength(46);
    expect(claude?.commands[0]).toEqual({
      name: "compact",
      description: COMPACT,
      input: "<optional custom summarization instructions>",
    });
    expect(claude?.commands.find((c) => c.name === "code-review")?.input).toBe(
      "[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>]",
    );
    expect(new Set(claude?.commands.map((c) => c.name)).size).toBe(46);
  });

  test("another instance's cache, a cache without a command list, or non-JSON is no catalog", () => {
    expect(parseRuntimeCommandCatalog(recorded("claude"), "codex")).toBeNull();
    expect(parseRuntimeCommandCatalog(JSON.stringify({ instanceId: "codex", driver: "codex" }), "codex")).toBeNull();
    expect(parseRuntimeCommandCatalog("not json", "codex")).toBeNull();
    expect(parseRuntimeCommandCatalog("[]", "codex")).toBeNull();
    // An advertised empty list is a real empty catalog, not a missing one.
    expect(parseRuntimeCommandCatalog(JSON.stringify({ instanceId: "codex", slashCommands: [] }), "codex")).toEqual({ commands: [] });
  });

  test("a queued native command is rejected when the live session catalog changed before dispatch", async () => {
    const sandbox = sandboxWithCaches({ codex: recorded("codex") });
    await expect(runtimeCommandDispatchRejection({
      ctx,
      sandbox,
      engine: "codex",
      session: { nativeSessionId: "replacement-session" },
      command: {
        name: "compact",
        provider: "codex",
        sessionId: "accepted-session",
        catalogRevision: 7,
      },
    })).resolves.toContain("session accepted != replacem");
    expect(sandbox.executed).toHaveLength(1);
  });

  test.each(["codex", "claude", "opencode"] as const)("%s: the probed catalog is recorded for (thread, engine, session)", async (engine: RuntimeEngineId) => {
    const sandbox = sandboxWithCaches({ [engine]: recorded(engine) });
    const { calls, record } = recorder();
    await recordRuntimeCommandCatalog({ ctx, sandbox, engine, session, record });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.timeoutMs).toBeUndefined();
    expect(calls[0]!.row).toEqual({
      threadId: "thread-1",
      provider: engine,
      nativeSessionId: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      commands: parseRuntimeCommandCatalog(recorded(engine), engine)!.commands,
    });
    // A root run with no thread id of its own is keyed by the run.
    await recordRuntimeCommandCatalog({ ctx: { runId: "run-1", signal: ctx.signal }, sandbox, engine, session, record, writeTimeoutMs: 250 });
    expect(calls[1]!.row.threadId).toBe("run-1");
    expect(calls[1]!.timeoutMs).toBe(250);
  });

  test("no readable snapshot records nothing: an unreadable cache is never an empty catalog", async () => {
    const { calls, record } = recorder();
    await recordRuntimeCommandCatalog({ ctx, sandbox: sandboxWithCaches({}), engine: "claude", session, record });
    const failing = { process: { executeCommand: async () => { throw new Error("sandbox gone"); } } };
    await recordRuntimeCommandCatalog({ ctx, sandbox: failing, engine: "claude", session, record });
    const foreign = sandboxWithCaches({ codex: recorded("claude") });
    await recordRuntimeCommandCatalog({ ctx, sandbox: foreign, engine: "codex", session, record });
    expect(calls).toHaveLength(0);
  });

  test("a transport that never settles cannot hold the turn: the read gives up at its own deadline", async () => {
    const { calls, record } = recorder();
    const read = recordRuntimeCommandCatalog({ ctx, sandbox: stalled, engine: "claude", session, record, deadlineMs: 50 });
    expect(await settles(read, 2_000)).toBe("settled");
    expect(calls).toHaveLength(0);
  });

  test("Stop ends a read in flight and a stopped run reads nothing at all", async () => {
    const { calls, record } = recorder();
    const stop = new AbortController();
    const read = recordRuntimeCommandCatalog({ ctx: { ...ctx, signal: stop.signal }, sandbox: stalled, engine: "claude", session, record });
    setTimeout(() => stop.abort(), 20);
    expect(await settles(read, 2_000)).toBe("settled");
    expect(calls).toHaveLength(0);
    const idle = sandboxWithCaches({ claude: recorded("claude") });
    await recordRuntimeCommandCatalog({ ctx: { ...ctx, signal: stop.signal }, sandbox: idle, engine: "claude", session, record });
    expect(idle.executed).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("Stop after the probe and before the write records nothing", async () => {
    const stop = new AbortController();
    const { calls, record } = recorder();
    const sandbox = {
      process: {
        executeCommand: async () => {
          stop.abort();
          return { exitCode: 0, result: recorded("codex") };
        },
      },
    };
    await recordRuntimeCommandCatalog({ ctx: { ...ctx, signal: stop.signal }, sandbox, engine: "codex", session, record });
    expect(calls).toHaveLength(0);
  });

  test("a write whose response never arrives cannot hold the turn: the wait ends at its own deadline, or at Stop", async () => {
    const sandbox = sandboxWithCaches({ codex: recorded("codex") });
    const timedOut = recordRuntimeCommandCatalog({ ctx, sandbox, engine: "codex", session, record: recorder("stalls").record, writeDeadlineMs: 50 });
    expect(await settles(timedOut, 2_000)).toBe("settled");
    const stop = new AbortController();
    const stopped = recordRuntimeCommandCatalog({ ctx: { ...ctx, signal: stop.signal }, sandbox, engine: "codex", session, record: recorder("stalls").record });
    setTimeout(() => stop.abort(), 20);
    expect(await settles(stopped, 2_000)).toBe("settled");
  });

  test("a write that fails after the turn stopped waiting is observed: logged, never an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      let reject: (error: Error) => void = () => {};
      const late: typeof recordSessionCommandCatalog = () => new Promise<void>((_, r) => { reject = r; });
      const sandbox = sandboxWithCaches({ codex: recorded("codex") });
      const read = recordRuntimeCommandCatalog({ ctx, sandbox, engine: "codex", session, record: late, writeDeadlineMs: 30 });
      expect(await settles(read, 2_000)).toBe("settled");
      reject(new Error("terminating connection due to administrator command"));
      await Bun.sleep(50);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  test("a write that fails or times out never reaches the worker: the read resolves without throwing", async () => {
    const sandbox = sandboxWithCaches({ codex: recorded("codex") });
    const { calls, record } = recorder("rejects");
    await expect(recordRuntimeCommandCatalog({ ctx, sandbox, engine: "codex", session, record })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    const grown: CanonicalCommand[] = [...parseRuntimeCommandCatalog(recorded("codex"), "codex")!.commands, { name: "review" }];
    sandbox.writeCache("codex", JSON.stringify({ instanceId: "codex", driver: "codex", slashCommands: grown }));
    const next = recorder();
    await recordRuntimeCommandCatalog({ ctx, sandbox, engine: "codex", session, record: next.record });
    expect(next.calls[0]!.row.commands).toEqual(grown);
  });
});
