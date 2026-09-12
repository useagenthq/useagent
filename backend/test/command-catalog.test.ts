import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { canonicalEvents, runs } from "../src/db/schema";
import { readLatestEngineCommandCatalog } from "../src/runs/command-catalog";
import { DEV_ORG_ID } from "../src/seed";
import { json, uid } from "./helpers";

/** A settled run in `orgId` whose native session advertised `commands` for `provider`,
 *  written as the durable canonical `commands.updated` the picker reads. */
async function advertise(
  orgId: string,
  provider: string,
  commands: { name: string; description?: string }[],
): Promise<string> {
  const runId = uid("run");
  await db.insert(runs).values({
    id: runId, prompt: "root", model: "claude-haiku-4-5", engine: provider === "mock" ? "mock" : "codex",
    status: "completed", threadId: runId, engineSessionId: `ses-${runId}`, orgId,
  }).onConflictDoNothing();
  await db.insert(canonicalEvents).values({
    eventId: `${runId}:commands`, revision: 0, runId, threadId: runId, seq: 0,
    kind: "commands.updated", ts: Date.now(),
    identity: { provider, nativeSessionId: `ses-${runId}` },
    body: { catalog: commands, commands: commands.map((c) => c.name) },
  });
  return runId;
}

describe("pre-session command catalog from the canonical stream", () => {
  test("returns the latest delivered catalog even when its wall-clock timestamp is older", async () => {
    const provider = uid("engine");
    await advertise(DEV_ORG_ID, provider, [{ name: "old-review" }]);
    const latestRun = await advertise(DEV_ORG_ID, provider, [{ name: "review", description: "Review the diff" }, { name: "status" }]);
    await db.update(canonicalEvents).set({ createdAt: new Date("2000-01-01T00:00:00Z") }).where(eq(canonicalEvents.runId, latestRun));
    const latest = await readLatestEngineCommandCatalog(DEV_ORG_ID, provider);
    expect(latest?.commands).toEqual([
      { name: "review", description: "Review the diff", input: null },
      { name: "status", description: null, input: null },
    ]);
    expect(latest?.fetchedAt).toBeInstanceOf(Date);
  });

  test("engines and orgs are isolated; an engine nobody ran yet has no catalog", async () => {
    const provider = uid("engine");
    await advertise(DEV_ORG_ID, provider, [{ name: "mine" }]);
    await advertise(uid("org"), provider, [{ name: "theirs" }]);
    expect((await readLatestEngineCommandCatalog(DEV_ORG_ID, provider))?.commands.map((c) => c.name)).toEqual(["mine"]);
    expect(await readLatestEngineCommandCatalog(DEV_ORG_ID, uid("other-engine"))).toBeNull();
  });

  test("GET /api/commands?engine= serves the current org's latest catalog for that engine", async () => {
    const provider = uid("engine");
    const commandName = uid("review");
    await advertise(DEV_ORG_ID, provider, [{ name: commandName, description: "review the diff" }]);
    const res = await json<{
      engine: string;
      commands: { name: string; description: string | null; input: string | null }[];
      fetched_at: string | null;
    }>(`/api/commands?engine=${encodeURIComponent(provider)}`);
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe(provider);
    expect(res.body.commands).toContainEqual({ name: commandName, description: "review the diff", input: null });
    expect(typeof res.body.fetched_at).toBe("string");

    const empty = await json<{ commands: unknown[]; fetched_at: string | null }>(`/api/commands?engine=${encodeURIComponent(uid("unused"))}`);
    expect(empty.status).toBe(200);
    expect(empty.body.commands).toEqual([]);
    expect(empty.body.fetched_at).toBeNull();
  });
});
