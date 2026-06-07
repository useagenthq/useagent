// C3/C4 (route integration): POST /api/runs authorizes a typed native-command intent FAIL-CLOSED
// against the LIVE session's authoritative catalog only. A command REQUIRES an active session +
// matching provider + native session id + catalog snapshot revision; the org priming cache is
// UI-only and NEVER authorizes execution. An unknown/malformed/stale intent is 400; a plain prompt
// that merely starts with "/" (no intent) stays a normal prompt with commandName null. DB-backed
// (useAgent_test), dev-org scoped.
import { describe, expect, test, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { canonicalEvents, commandsCatalog, runs } from "../src/db/schema";
import { acpCatalogKey, readSessionCommandCatalog } from "../src/runs/command-catalog";
import { DEV_ORG_ID } from "../src/seed";
import { fetchApi, waitFor } from "./helpers";

beforeAll(async () => {
  await waitFor(() => true, 1);
  // Seed the ORG PRIMING cache (what the pre-session New Task picker shows). engine "mock" is
  // non-opencode, so the picker reads acp:<org>:mock. C3: this must NEVER authorize execution.
  const cache = [{ name: "review", description: null, input: null }, { name: "status", description: null, input: null }];
  await db
    .insert(commandsCatalog)
    .values({ snapshot: acpCatalogKey(DEV_ORG_ID, "mock"), commands: cache, fetchedAt: new Date() })
    .onConflictDoUpdate({ target: commandsCatalog.snapshot, set: { commands: cache } });
});

async function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; id?: string }> {
  const res = await fetchApi("/api/runs", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
  const j = (await res.json().catch(() => ({}))) as { id?: string };
  return { status: res.status, id: j.id };
}
const getRun = async (id: string) => (await db.select().from(runs).where(eq(runs.id, id)).limit(1))[0];
const uid = () => crypto.randomUUID();

/** A completed parent run holding a live session, with the session's authoritative catalog written
 *  as a durable canonical `commands.updated`. Returns the parent id + the event's deliverySeq -
 *  the SNAPSHOT REVISION a command must carry to authorize. `null` sessionCommands => write NO
 *  catalog event (simulates a catalog-persistence failure: nothing authoritative exists). */
async function seedParentWithSession(sessionId: string, sessionCommands: string[] | null): Promise<{ parentId: string; revision: number | null }> {
  const parentId = uid();
  await db.insert(runs).values({
    id: parentId, prompt: "root", model: "claude-haiku-4-5", engine: "mock", status: "completed",
    threadId: parentId, engineSessionId: sessionId, orgId: DEV_ORG_ID,
  }).onConflictDoNothing();
  if (sessionCommands === null) return { parentId, revision: null };
  const [row] = await db.insert(canonicalEvents).values({
    eventId: `${parentId}:${sessionId}:commands`, revision: 0, runId: parentId, threadId: parentId, seq: 0,
    kind: "commands.updated", ts: 1,
    identity: { provider: "mock", nativeSessionId: sessionId },
    body: { commands: sessionCommands, catalog: sessionCommands.map((n) => ({ name: n })) },
  }).returning({ deliverySeq: canonicalEvents.deliverySeq });
  return { parentId, revision: Number(row!.deliverySeq) };
}

describe("POST /api/runs - fail-closed: a command REQUIRES a live session (C3)", () => {
  test("a command with NO active session is rejected 400 (priming cache never authorizes)", async () => {
    // `review` IS in the org priming cache seeded above - it must STILL be rejected with no session.
    const r = await post({ prompt: "/review", engine: "mock", command: { name: "review", provider: "mock" } });
    expect(r.status).toBe(400);
  });

  test("SECURITY: a plain prompt starting with '/' but NO intent stays a normal prompt (commandName null)", async () => {
    const r = await post({ prompt: "/review this is just prose", engine: "mock" });
    expect(r.status).toBe(201);
    const run = await getRun(r.id!);
    expect(run?.commandName).toBeNull();
    expect(run?.prompt).toBe("/review this is just prose");
  });
});

describe("POST /api/runs - session-authoritative command authorization (C3)", () => {
  test("an accepted command replays after its live session and catalog disappear", async () => {
    const { parentId, revision } = await seedParentWithSession(
      "ses_replay_gone",
      ["deploy"],
    );
    const key = `command-replay:${crypto.randomUUID()}`;
    const body = {
      prompt: "/deploy x  y",
      engine: "mock",
      parent_run_id: parentId,
      command: {
        name: "deploy",
        args: "x  y",
        provider: "mock",
        sessionId: "ses_replay_gone",
        catalogRevision: revision,
      },
    };
    const first = await post(body, { "Idempotency-Key": key });
    expect(first.status).toBe(201);

    await db.delete(canonicalEvents).where(eq(canonicalEvents.runId, parentId));
    await db.update(runs).set({ engineSessionId: null }).where(eq(runs.id, parentId));

    const replay = await post(body, { "Idempotency-Key": key });
    expect(replay).toEqual({ status: 200, id: first.id });
  });

  test("a reply command in the session catalog with matching provider+session+revision validates + persists identity", async () => {
    const { parentId, revision } = await seedParentWithSession("ses_live", ["deploy"]); // NOT in the org cache
    const r = await post({ prompt: "/deploy x  y", engine: "mock", parent_run_id: parentId, command: { name: "deploy", args: "x  y", provider: "mock", sessionId: "ses_live", catalogRevision: revision } });
    expect(r.status).toBe(201);
    const run = await getRun(r.id!);
    expect(run?.commandName).toBe("deploy");
    expect(run?.prompt).toBe("/deploy x  y"); // built ONCE in the backend, verbatim args
    // the ACCEPTED identity is persisted with the run, not only the name
    expect(run?.commandProvider).toBe("mock");
    expect(run?.commandSessionId).toBe("ses_live");
    expect(Number(run?.commandCatalogRevision)).toBe(revision);
  });

  test("native command bytes never discover or widen resources", async () => {
    const { parentId, revision } = await seedParentWithSession("ses_resource_bytes", ["deploy"]);
    const args = "https://github.com/Other/private/pull/7";
    const r = await post({
      prompt: `/deploy ${args}`,
      engine: "mock",
      parent_run_id: parentId,
      command: {
        name: "deploy",
        args,
        provider: "mock",
        sessionId: "ses_resource_bytes",
        catalogRevision: revision,
      },
    });
    expect(r.status).toBe(201);
    const run = await getRun(r.id!);
    expect(run?.prompt).toBe(`/deploy ${args}`);
    expect(run?.resolvedResources).toEqual([]);
  });

  test("a MISSING catalog revision is rejected (client must prove the snapshot it selected)", async () => {
    const { parentId } = await seedParentWithSession("ses_norev", ["deploy"]);
    const r = await post({ prompt: "/deploy", engine: "mock", parent_run_id: parentId, command: { name: "deploy", provider: "mock", sessionId: "ses_norev" } });
    expect(r.status).toBe(400);
  });

  test("a STALE catalog revision is rejected", async () => {
    const { parentId, revision } = await seedParentWithSession("ses_stale", ["deploy"]);
    const r = await post({ prompt: "/deploy", engine: "mock", parent_run_id: parentId, command: { name: "deploy", provider: "mock", sessionId: "ses_stale", catalogRevision: (revision ?? 0) - 1 } });
    expect(r.status).toBe(400);
  });

  test("a WRONG/stale session id is rejected even for a valid command name", async () => {
    const { parentId, revision } = await seedParentWithSession("ses_current", ["deploy"]);
    const r = await post({ prompt: "/deploy", engine: "mock", parent_run_id: parentId, command: { name: "deploy", provider: "mock", sessionId: "ses_OLD", catalogRevision: revision } });
    expect(r.status).toBe(400);
  });

  test("a command in the ORG cache but NOT the current session is rejected (session overrides cache)", async () => {
    const { parentId, revision } = await seedParentWithSession("ses_live2", ["deploy"]); // session has only `deploy`
    // `review` IS in the org cache but NOT this session's catalog -> 400.
    const r = await post({ prompt: "/review", engine: "mock", parent_run_id: parentId, command: { name: "review", provider: "mock", sessionId: "ses_live2", catalogRevision: revision } });
    expect(r.status).toBe(400);
  });

  test("a WRONG provider for the engine is rejected", async () => {
    const { parentId, revision } = await seedParentWithSession("ses_prov", ["deploy"]);
    const r = await post({ prompt: "/deploy", engine: "mock", parent_run_id: parentId, command: { name: "deploy", provider: "claude", sessionId: "ses_prov", catalogRevision: revision } });
    expect(r.status).toBe(400);
  });

  test("a session that advertised NONE (empty catalog) rejects any command", async () => {
    const { parentId, revision } = await seedParentWithSession("ses_empty", []); // advertised none
    const r = await post({ prompt: "/review", engine: "mock", parent_run_id: parentId, command: { name: "review", provider: "mock", sessionId: "ses_empty", catalogRevision: revision } });
    expect(r.status).toBe(400);
  });
});

// D3: an EMPTY catalog replacement is DURABLE (opencode/ACP persist empty too) and is DISTINCT
// from a session that has never advertised - the former authorizes no command but is an authoritative
// "advertises none" (a revision exists); the latter is null (fail-closed, may fall back to priming).
describe("readSessionCommandCatalog (empty replacement is durable, distinct from not-advertised)", () => {
  test("an EMPTY commands.updated -> {commands:[], revision}; a never-advertised session -> null", async () => {
    const { parentId, revision } = await seedParentWithSession("ses_empty_persist", []); // empty catalog
    const cat = await readSessionCommandCatalog(parentId, "mock", "ses_empty_persist");
    expect(cat).not.toBeNull();
    expect(cat?.commands).toEqual([]);
    expect(cat?.revision).toBe(revision);
    expect(await readSessionCommandCatalog(parentId, "mock", "ses_never_advertised")).toBeNull();
  });

  test("catalog lookup is scoped by provider as well as native session", async () => {
    const { parentId } = await seedParentWithSession("shared_session", ["deploy"]);
    await db.insert(canonicalEvents).values({
      eventId: `${parentId}:codex:shared_session:commands`, revision: 0, runId: parentId,
      threadId: parentId, seq: 1, kind: "commands.updated", ts: 2,
      identity: { provider: "codex", nativeSessionId: "shared_session" },
      body: { commands: ["plan"], catalog: [{ name: "plan" }] },
    });

    expect((await readSessionCommandCatalog(parentId, "mock", "shared_session"))?.commands).toEqual([
      { name: "deploy", description: null, input: null },
    ]);
    expect((await readSessionCommandCatalog(parentId, "codex", "shared_session"))?.commands).toEqual([
      { name: "plan", description: null, input: null },
    ]);
  });
});

// C4: when the authoritative catalog could NOT be persisted (no durable commands.updated for the
// session), NO command can be authorized afterward - the priming cache does not rescue it.
describe("POST /api/runs - persistence-failure consequence (C4)", () => {
  test("a session with NO durable catalog (persist failed) authorizes NO command, even one in the org cache", async () => {
    const { parentId } = await seedParentWithSession("ses_nocatalog", null); // catalog never persisted
    // `review` is in the org priming cache; with no authoritative session catalog it is STILL 400.
    const r = await post({ prompt: "/review", engine: "mock", parent_run_id: parentId, command: { name: "review", provider: "mock", sessionId: "ses_nocatalog", catalogRevision: 1 } });
    expect(r.status).toBe(400);
  });
});
