// The runtime engines (codex, claude, opencode) record the command list their
// session advertises in the session command catalog table; readSessionCommandCatalog
// serves it, with its revision, to the reply route, so a typed native command
// (Compact, "/feedback") authorizes against exactly what the session advertised.
// DB-backed, through the REAL adapter hook and the REAL bounded write, with the
// catalogs recorded from the pinned runtime. The table is never a provider event:
// nothing here lands in provider_events, and finalization's drain and seals never
// wait on it.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ACP_COMMANDS_EVENT_TYPE } from "@useagent/agent-harness/canonical";
import { client, db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { recordRuntimeCommandCatalog } from "../src/engines/runtime-command-catalog";
import { PROVIDER_INSTANCE, runtimeThreadId, type RuntimeEngineId } from "../src/engines/runtime-orchestration";
import { canonicalizeRun } from "../src/runs/canonicalization-outbox";
import { readSessionCommandCatalog } from "../src/runs/command-catalog";
import { validateCommandIntent } from "../src/runs/command-intent";
import { prepareExecutionGraphSeal } from "../src/runs/execution-graph-seal";
import { drainProviderEvents, recordProviderEvent } from "../src/runs/provider-events";
import { DEV_ORG_ID } from "../src/seed";
import { SANDBOX_NAME_PREFIX } from "../src/sandboxes/sandbox-names";
import { json, uid, waitFor } from "./helpers"; // side-effect: migrate + seed

beforeAll(async () => {
  await waitFor(() => true, 1);
});

const FIXTURES = new URL("./fixtures/runtime-command-catalog/", import.meta.url);
const recorded = (engine: RuntimeEngineId): string =>
  readFileSync(new URL(`${PROVIDER_INSTANCE[engine]}.json`, FIXTURES), "utf8");

/** A sandbox whose probe answers with a recorded status cache (the shell probe
 *  itself is exercised in the engine unit test). */
const sandboxAdvertising = (output: string) => ({
  process: { executeCommand: async () => ({ exitCode: 0, result: output }) },
});
const signal = () => new AbortController().signal;

async function seedRun(engine: RuntimeEngineId, threadId?: string, orgId: string = DEV_ORG_ID) {
  const runId = uid("scc");
  const thread = threadId ?? runId;
  await db.insert(runs).values({
    id: runId, prompt: "p", model: "claude-haiku-4-5", engine, status: "completed", threadId: thread, orgId,
  }).onConflictDoNothing();
  return { runId, threadId: thread };
}

const namesOf = (catalog: { commands: readonly { name: string }[] } | null) => catalog?.commands.map((c) => c.name);

describe("session command catalog table -> readSessionCommandCatalog", () => {
  test.each(["codex", "claude", "opencode"] as const)(
    "%s: the recorded catalog is readable for (thread, engine, session) with revision 1 and never enters the run's sequence",
    async (engine: RuntimeEngineId) => {
      const { runId, threadId } = await seedRun(engine);
      const ctx = { runId, threadId, signal: signal() };
      const sessionId = runtimeThreadId(ctx);
      await recordRuntimeCommandCatalog({ ctx, engine, sandbox: sandboxAdvertising(recorded(engine)), session: { nativeSessionId: sessionId } });

      const catalog = await readSessionCommandCatalog(threadId, engine, sessionId);
      expect(catalog?.revision).toBe(1);
      expect(namesOf(catalog)).toContain("compact");
      expect(catalog?.commands[0]).toEqual({
        name: "compact",
        description: "Summarize the conversation and reduce context usage",
        input: engine === "claude" ? "<optional custom summarization instructions>" : null,
      });
      // The runtime's own provider tag never names the catalog; the engine does.
      expect(await readSessionCommandCatalog(threadId, "t3", sessionId)).toBeNull();
      // No provider frame, no sequence number: the run's provider-event lane is untouched.
      expect(await client`select 1 from provider_events where run_id = ${runId}`).toHaveLength(0);
      const sealed = await canonicalizeRun(runId, threadId);
      expect(sealed.complete).toBe(true);
      expect(sealed.delivered.filter((e) => e.kind === "commands.updated")).toHaveLength(0);

      // What the reply route does with a typed Compact from the composer.
      const intent = { name: "compact", provider: engine, sessionId, catalogRevision: catalog!.revision };
      expect(validateCommandIntent(intent, catalog!.commands, { sessionId, revision: catalog!.revision }))
        .toEqual({ ok: true, name: "compact", args: "" });
      expect(validateCommandIntent({ ...intent, name: "deploy" }, catalog!.commands, { sessionId, revision: catalog!.revision }))
        .toEqual({ ok: false, reason: "unknown command" });
      expect(validateCommandIntent({ ...intent, catalogRevision: 7 }, catalog!.commands, { sessionId, revision: catalog!.revision }))
        .toEqual({ ok: false, reason: "stale catalog revision" });
    },
  );

  test("a reply turn re-records the catalog: a changed list raises the revision, an unchanged list keeps it", async () => {
    const root = await seedRun("codex");
    const sessionId = runtimeThreadId({ runId: root.runId, threadId: root.threadId });
    const session = { nativeSessionId: sessionId };
    await recordRuntimeCommandCatalog({ ctx: { ...root, signal: signal() }, engine: "codex", sandbox: sandboxAdvertising(recorded("codex")), session });
    const first = await readSessionCommandCatalog(root.threadId, "codex", sessionId);
    expect(first?.revision).toBe(1);

    const reply = await seedRun("codex", root.threadId);
    const replyCtx = { runId: reply.runId, threadId: reply.threadId, signal: signal() };
    // The same list again (the reply's read after session.started): nothing changes.
    await recordRuntimeCommandCatalog({ ctx: replyCtx, engine: "codex", sandbox: sandboxAdvertising(recorded("codex")), session });
    expect((await readSessionCommandCatalog(root.threadId, "codex", sessionId))?.revision).toBe(1);

    const grown = JSON.stringify({
      instanceId: "codex", driver: "codex",
      slashCommands: [...JSON.parse(recorded("codex")).slashCommands, { name: "review", description: "Review the diff" }],
    });
    await recordRuntimeCommandCatalog({ ctx: replyCtx, engine: "codex", sandbox: sandboxAdvertising(grown), session });
    const latest = await readSessionCommandCatalog(root.threadId, "codex", sessionId);
    expect(latest?.revision).toBe(2);
    expect(namesOf(latest)).toEqual(["compact", "feedback", "review"]);
    // The revision the composer held for the old list is now stale, as it must be.
    expect(validateCommandIntent({ name: "compact", provider: "codex", sessionId, catalogRevision: first!.revision }, latest!.commands, { sessionId, revision: latest!.revision }))
      .toEqual({ ok: false, reason: "stale catalog revision" });
  });

  test("engines and sessions stay distinct within a thread, and threads are distinct", async () => {
    const { runId, threadId } = await seedRun("claude");
    const sessionId = runtimeThreadId({ runId, threadId });
    await recordRuntimeCommandCatalog({ ctx: { runId, threadId, signal: signal() }, engine: "claude", sandbox: sandboxAdvertising(recorded("claude")), session: { nativeSessionId: sessionId } });
    expect(await readSessionCommandCatalog(threadId, "codex", sessionId)).toBeNull();
    expect(await readSessionCommandCatalog(threadId, "claude", `${SANDBOX_NAME_PREFIX}-thread-other`)).toBeNull();
    expect(await readSessionCommandCatalog(uid("thread"), "claude", sessionId)).toBeNull();
    expect((await readSessionCommandCatalog(threadId, "claude", sessionId))?.commands).toHaveLength(46);
  });

  test("a catalog the size of a skill-heavy Claude session is recorded whole", async () => {
    const { runId, threadId } = await seedRun("claude");
    const sessionId = runtimeThreadId({ runId, threadId });
    const slashCommands = Array.from({ length: 180 }, (_, i) => ({ name: `skill-${i}`, description: "d".repeat(220), input: { hint: "[args]" } }));
    const output = JSON.stringify({ instanceId: "claudeAgent", driver: "claudeAgent", slashCommands });
    expect(output.length).toBeGreaterThan(32 * 1024);
    await recordRuntimeCommandCatalog({ ctx: { runId, threadId, signal: signal() }, engine: "claude", sandbox: sandboxAdvertising(output), session: { nativeSessionId: sessionId } });
    const catalog = await readSessionCommandCatalog(threadId, "claude", sessionId);
    expect(catalog?.commands).toHaveLength(180);
    expect(catalog?.commands[179]).toEqual({ name: "skill-179", description: "d".repeat(220), input: "[args]" });
  });

  test("a Pi session still resolves through the canonical stream: its commands.updated and delivery sequence", async () => {
    const { runId, threadId } = await seedRun("claude");
    const sessionId = `pi-${runId}`;
    await recordProviderEvent({
      id: `${runId}:pi:${sessionId}:commands`, runId, threadId, provider: "pi", eventType: ACP_COMMANDS_EVENT_TYPE,
      nativeSessionId: sessionId, payload: { source: "pi", generation: 1, commands: [{ name: "compact" }, { name: "review", description: "Review the diff" }] },
    });
    const sealed = await canonicalizeRun(runId, threadId);
    const delivered = sealed.delivered.find((e) => e.kind === "commands.updated");
    expect(delivered?.identity).toMatchObject({ provider: "pi", nativeSessionId: sessionId });
    const catalog = await readSessionCommandCatalog(threadId, "pi", sessionId);
    expect(catalog?.revision).toBe(delivered!.deliverySeq);
    expect(catalog?.commands).toEqual([
      { name: "compact", description: null, input: null },
      { name: "review", description: "Review the diff", input: null },
    ]);
    expect(validateCommandIntent({ name: "compact", provider: "pi", sessionId, catalogRevision: catalog!.revision }, catalog!.commands, { sessionId, revision: catalog!.revision }))
      .toEqual({ ok: true, name: "compact", args: "" });
  });

  test("a stalled write cannot hold the turn: the wait ends at the plane's deadline or at Stop, the statement ends at its timeout with nothing recorded and no unhandled rejection, and the drain and the seals never wait on it", async () => {
    const { runId, threadId } = await seedRun("claude");
    const sessionId = runtimeThreadId({ runId, threadId });
    const session = { nativeSessionId: sessionId };
    // An ordinary provider frame of the turn, through the real sequencer, so the drain has a queue to wait on.
    await recordProviderEvent({
      id: `${runId}:${sessionId}:session`, runId, threadId, provider: "t3", eventType: "session.started",
      nativeSessionId: sessionId, payload: { source: "claude", resumed: false, capabilities: {} },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    // A REAL stalled write: another connection holds an uncommitted row for the same key
    // inside an open transaction, so the catalog upsert blocks in Postgres until that
    // transaction ends. Nothing on the plane cancels it; the server's statement_timeout does.
    const holder = await client.reserve();
    await holder`begin`;
    await holder`insert into session_command_catalogs (thread_id, provider, native_session_id, commands)
      values (${threadId}, ${"claude"}, ${sessionId}, ${"[]"}::jsonb)`;
    try {
      // The turn's wait is bounded on the plane, well inside the statement's own timeout.
      const startedAt = Date.now();
      const timedOut = recordRuntimeCommandCatalog({
        ctx: { runId, threadId, signal: signal() }, engine: "claude",
        sandbox: sandboxAdvertising(recorded("claude")), session, writeTimeoutMs: 1_500, writeDeadlineMs: 200,
      });
      expect(await Promise.race([timedOut.then(() => "settled"), Bun.sleep(3_000).then(() => "still pending")])).toBe("settled");
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      // The statement is still blocked in the database. Finalization's own waits do not see it:
      // the drain settles at once and the seals run.
      expect(await Promise.race([drainProviderEvents(runId).then(() => "drained"), Bun.sleep(2_000).then(() => "blocked")])).toBe("drained");
      expect(await Promise.race([prepareExecutionGraphSeal(runId).then(() => "sealed"), Bun.sleep(2_000).then(() => "blocked")])).toBe("sealed");
      const sealed = await Promise.race([canonicalizeRun(runId, threadId), Bun.sleep(5_000).then(() => null)]);
      expect(sealed?.complete).toBe(true);
      // Stop while a second statement is blocked: the wait ends at once.
      const stop = new AbortController();
      const stopped = recordRuntimeCommandCatalog({
        ctx: { runId, threadId, signal: stop.signal }, engine: "claude",
        sandbox: sandboxAdvertising(recorded("claude")), session, writeTimeoutMs: 1_500,
      });
      setTimeout(() => stop.abort(), 100);
      const stopAt = Date.now();
      expect(await Promise.race([stopped.then(() => "settled"), Bun.sleep(3_000).then(() => "still pending")])).toBe("settled");
      expect(Date.now() - stopAt).toBeLessThan(1_000);
      // Both statements end at the server's statement_timeout while the lock is still held.
      await Bun.sleep(1_800);
    } finally {
      await holder`rollback`.catch(() => {});
      holder.release();
    }
    // Nothing of the timed-out statements lands once the lock is gone (the holder's own row rolled back).
    await Bun.sleep(200);
    expect(await readSessionCommandCatalog(threadId, "claude", sessionId)).toBeNull();
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    // With the lock gone, the next read records normally.
    await recordRuntimeCommandCatalog({ ctx: { runId, threadId, signal: signal() }, engine: "claude", sandbox: sandboxAdvertising(recorded("claude")), session });
    const catalog = await readSessionCommandCatalog(threadId, "claude", sessionId);
    expect(catalog?.revision).toBe(1);
    expect(catalog?.commands).toHaveLength(46);
  }, 30_000);

  test("GET /api/commands with thread and session serves the session's own catalog with its revision, org-scoped", async () => {
    const { runId, threadId } = await seedRun("codex");
    const sessionId = runtimeThreadId({ runId, threadId });
    const query = (thread: string, session: string) =>
      json<{ engine: string; commands: { name: string }[]; revision: number | null; session: string | null; fetched_at: string | null }>(
        `/api/commands?engine=codex&thread=${encodeURIComponent(thread)}&session=${encodeURIComponent(session)}`,
      );
    // Before the session advertised: the org snapshot primes, with no revision and no session.
    const before = await query(threadId, sessionId);
    expect(before.status).toBe(200);
    expect(before.body.revision).toBeNull();
    expect(before.body.session).toBeNull();

    await recordRuntimeCommandCatalog({ ctx: { runId, threadId, signal: signal() }, engine: "codex", sandbox: sandboxAdvertising(recorded("codex")), session: { nativeSessionId: sessionId } });
    const own = await query(threadId, sessionId);
    expect(own.status).toBe(200);
    expect(own.body).toEqual({
      engine: "codex",
      commands: [
        { name: "compact", description: "Summarize the conversation and reduce context usage", input: null },
        { name: "feedback", description: "Send this thread and Codex logs to OpenAI", input: "Describe the issue (optional)" },
      ],
      revision: 1,
      session: sessionId,
      fetched_at: null,
    });
    // Another session of the thread never sees it; another org's thread answers exactly like
    // a thread with no catalog (200, the caller's own org snapshot), never a different status.
    expect((await query(threadId, `${SANDBOX_NAME_PREFIX}-thread-other`)).body).toMatchObject({ revision: null, session: null });
    const foreign = await seedRun("codex", undefined, uid("org"));
    const foreignSession = runtimeThreadId({ runId: foreign.runId, threadId: foreign.threadId });
    await recordRuntimeCommandCatalog({ ctx: { ...foreign, signal: signal() }, engine: "codex", sandbox: sandboxAdvertising(recorded("codex")), session: { nativeSessionId: foreignSession } });
    const other = await query(foreign.threadId, foreignSession);
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ revision: null, session: null });
    expect(other.body.commands.map((c) => c.name)).not.toContain("feedback");
  });
});
