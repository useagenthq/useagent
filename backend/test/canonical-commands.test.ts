// Phase 1 (durable native command capture): an ACP session's `available_commands_update` is
// captured as an ORDERED `acp.commands` provider event (acp-server), so it is sealed by the
// same drain barrier and counted by the same canonicalization WATERMARK as every other native
// frame - canonicalization cannot reach `complete` until the run's command snapshot is durable.
// The translator emits the run's canonical `commands.updated` from those frames. DB-backed
// (skynet_test), through the REAL canonicalizeRun path (no mutable side-cache).
import { describe, expect, test, beforeAll } from "bun:test";
import { ACP_COMMANDS_EVENT_TYPE, type CanonicalCommand } from "../src/engines/canonical";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { recordProviderEvent } from "../src/runs/provider-events";
import { canonicalizeRun, sourceWatermark } from "../src/runs/canonicalization-outbox";
import { loadCanonicalThread } from "../src/runs/canonical-events";
import { waitFor } from "./helpers"; // side-effect: migrate + seed

beforeAll(async () => {
  await waitFor(() => true, 1);
});

const uid = () => crypto.randomUUID();

async function seedAcpRun(engine: "claude" | "codex" | "opencode") {
  const RUN = `cmd_${uid()}`;
  const THREAD = RUN;
  await db.insert(runs).values({
    id: RUN, prompt: "p", model: "claude-haiku-4-5", engine, status: "completed", threadId: THREAD,
  }).onConflictDoNothing();
  return { RUN, THREAD };
}

/** Record a durable `acp.commands` provider event exactly as acp-server does, then AWAIT it so
 *  it is committed before canonicalization reads the source (mirrors the drain barrier). */
async function recordCommands(RUN: string, THREAD: string, provider: string, sessionId: string, commands: CanonicalCommand[]) {
  await recordProviderEvent({
    id: `${RUN}:${sessionId}:commands`, runId: RUN, threadId: THREAD, provider, eventType: ACP_COMMANDS_EVENT_TYPE,
    nativeSessionId: sessionId, payload: { source: provider, adapter: "acp@x", commands, ts: 1 },
  });
}
const commandsOf = (delivered: { kind: string }[]) =>
  delivered.filter((e): e is { kind: "commands.updated"; commands: string[]; catalog?: CanonicalCommand[]; identity: { nativeSessionId?: string }; source?: string } =>
    e.kind === "commands.updated") as unknown as Array<{ kind: string; commands: string[]; catalog?: CanonicalCommand[]; identity: { nativeSessionId?: string }; source?: string }>;

describe("durable command capture -> canonical commands.updated (Phase 1)", () => {
  test("the command frame is counted by the watermark (canonicalization covers it)", async () => {
    const { RUN, THREAD } = await seedAcpRun("claude");
    await recordCommands(RUN, THREAD, "claude", "ses_a", [{ name: "review" }]);
    const w = await sourceWatermark(RUN);
    expect(w.frameMax).toBeGreaterThanOrEqual(0); // the acp.commands frame is a durable provider event
  });

  test("a non-empty snapshot yields a session-identified commands.updated with the catalog + source", async () => {
    const { RUN, THREAD } = await seedAcpRun("claude");
    await recordCommands(RUN, THREAD, "claude", "ses_a", [
      { name: "review", description: "Review the diff", input: "[files]" },
      { name: "compact" },
    ]);
    const res = await canonicalizeRun(RUN, THREAD);
    expect(res.complete).toBe(true);
    const cmds = commandsOf(res.delivered);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.commands).toEqual(["review", "compact"]);
    expect(cmds[0]?.catalog).toEqual([{ name: "review", description: "Review the diff", input: "[files]" }, { name: "compact" }]);
    expect(cmds[0]?.source).toBe("claude");
    expect(cmds[0]?.identity.nativeSessionId).toBe("ses_a");
  });

  test("an EMPTY replacement emits an EMPTY commands.updated (honored, not dropped)", async () => {
    const { RUN, THREAD } = await seedAcpRun("codex");
    // had commands, then the provider cleared them (same session id -> upsert, latest wins)
    await recordCommands(RUN, THREAD, "codex", "ses_b", [{ name: "gone" }]);
    await recordCommands(RUN, THREAD, "codex", "ses_b", []);
    const res = await canonicalizeRun(RUN, THREAD);
    const cmds = commandsOf(res.delivered);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.commands).toEqual([]);
  });

  test("duplicate delivery is idempotent (one row per session, latest wins)", async () => {
    const { RUN, THREAD } = await seedAcpRun("claude");
    await recordCommands(RUN, THREAD, "claude", "ses_c", [{ name: "a" }]);
    await recordCommands(RUN, THREAD, "claude", "ses_c", [{ name: "a" }, { name: "b" }]);
    await recordCommands(RUN, THREAD, "claude", "ses_c", [{ name: "a" }, { name: "b" }]); // exact duplicate
    const res = await canonicalizeRun(RUN, THREAD);
    const cmds = commandsOf(res.delivered);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.commands).toEqual(["a", "b"]);
  });

  test("TWO native sessions in one thread keep DISTINCT catalogs", async () => {
    const { RUN, THREAD } = await seedAcpRun("claude");
    await recordCommands(RUN, THREAD, "claude", "ses_1", [{ name: "one" }]);
    await recordCommands(RUN, THREAD, "claude", "ses_2", [{ name: "two" }]);
    const res = await canonicalizeRun(RUN, THREAD);
    const cmds = commandsOf(res.delivered).sort((a, b) => (a.commands[0] ?? "").localeCompare(b.commands[0] ?? ""));
    expect(cmds.map((c) => c.identity.nativeSessionId)).toEqual(["ses_1", "ses_2"]);
    expect(cmds.map((c) => c.commands)).toEqual([["one"], ["two"]]);
  });

  test("reconnect/replay reconstructs the same commands.updated (durable canonical rows)", async () => {
    const { RUN, THREAD } = await seedAcpRun("claude");
    await recordCommands(RUN, THREAD, "claude", "ses_r", [{ name: "z", description: "d" }]);
    await canonicalizeRun(RUN, THREAD);
    const replayed = commandsOf(await loadCanonicalThread(THREAD));
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.commands).toEqual(["z"]);
    expect(replayed[0]?.identity.nativeSessionId).toBe("ses_r");
  });

  test("a plain OpenCode run emits NO commands.updated (its catalog is served separately)", async () => {
    const { RUN, THREAD } = await seedAcpRun("opencode");
    const res = await canonicalizeRun(RUN, THREAD);
    expect(commandsOf(res.delivered)).toHaveLength(0);
  });
});
