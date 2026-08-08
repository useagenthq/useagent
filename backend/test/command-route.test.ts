// Phase 3 (route integration): POST /api/runs validates a typed native-command intent against
// the active authoritative catalog BEFORE it may skip context. A validated intent stores the
// command name + the verbatim `/name args` prompt (built once in the backend); an unknown or
// malformed intent is a 400; a plain prompt that merely starts with "/" (no intent) stays a
// normal prompt with commandName null. DB-backed (skynet_test), dev-org scoped.
import { describe, expect, test, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { canonicalEvents, commandsCatalog, runs } from "../src/db/schema";
import { acpCatalogKey } from "../src/runs/command-catalog";
import { DEV_ORG_ID } from "../src/seed";
import { fetchApi, waitFor } from "./helpers";

beforeAll(async () => {
  await waitFor(() => true, 1);
  // Seed the engine's authoritative catalog (what the picker offered). engine "mock" is
  // non-opencode, so the route reads acp:<org>:mock.
  await db
    .insert(commandsCatalog)
    .values({ snapshot: acpCatalogKey(DEV_ORG_ID, "mock"), commands: [{ name: "review", description: null, input: null }, { name: "status", description: null, input: null }], fetchedAt: new Date() })
    .onConflictDoUpdate({ target: commandsCatalog.snapshot, set: { commands: [{ name: "review", description: null, input: null }, { name: "status", description: null, input: null }] } });
});

async function post(body: unknown): Promise<{ status: number; id?: string }> {
  const res = await fetchApi("/api/runs", { method: "POST", body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { id?: string };
  return { status: res.status, id: j.id };
}
const getRun = async (id: string) => (await db.select().from(runs).where(eq(runs.id, id)).limit(1))[0];

describe("POST /api/runs - typed native-command intent (Phase 3)", () => {
  test("a VALIDATED command stores the command name + the verbatim /name args prompt", async () => {
    const r = await post({ prompt: "/review whatever", engine: "mock", command: { name: "review", args: "src/app.ts  padded" } });
    expect(r.status).toBe(201);
    const run = await getRun(r.id!);
    expect(run?.commandName).toBe("review");
    // built ONCE in the backend from name + original arg bytes (not the client's prompt field)
    expect(run?.prompt).toBe("/review src/app.ts  padded");
  });

  test("an UNKNOWN command is rejected with 400 (never silently executed)", async () => {
    const r = await post({ prompt: "x", engine: "mock", command: { name: "notacommand" } });
    expect(r.status).toBe(400);
  });

  test("a WRONG provider for the engine is rejected", async () => {
    const r = await post({ prompt: "x", engine: "mock", command: { name: "review", provider: "claude" } });
    expect(r.status).toBe(400);
  });

  test("SECURITY: a plain prompt that starts with '/' but has NO intent stays a normal prompt (commandName null)", async () => {
    const r = await post({ prompt: "/review this is just prose", engine: "mock" });
    expect(r.status).toBe(201);
    const run = await getRun(r.id!);
    expect(run?.commandName).toBeNull();
    expect(run?.prompt).toBe("/review this is just prose"); // stored raw, and the worker will add context
  });

  test("a command with NO args stores just /name", async () => {
    const r = await post({ prompt: "/status", engine: "mock", command: { name: "status" } });
    expect(r.status).toBe(201);
    const run = await getRun(r.id!);
    expect(run?.commandName).toBe("status");
    expect(run?.prompt).toBe("/status");
  });
});

// Blockers #2 (session-authoritative validation) + #3 (active-run session identity): a REPLY is
// validated against the CURRENT session's durable catalog (not the org cache), and the client
// session id must match the server-derived active session.
describe("POST /api/runs - session-authoritative command validation (blockers #2/#3)", () => {
  const uid = () => crypto.randomUUID();
  async function seedParentWithSession(sessionId: string, sessionCommands: string[]) {
    const parentId = uid();
    await db.insert(runs).values({
      id: parentId, prompt: "root", model: "claude-haiku-4-5", engine: "mock", status: "completed",
      threadId: parentId, engineSessionId: sessionId, orgId: DEV_ORG_ID,
    }).onConflictDoNothing();
    // the session's authoritative catalog, as a durable canonical commands.updated
    await db.insert(canonicalEvents).values({
      eventId: `${parentId}:${sessionId}:commands`, revision: 0, runId: parentId, threadId: parentId, seq: 0,
      kind: "commands.updated", ts: 1,
      identity: { provider: "mock", nativeSessionId: sessionId },
      body: { commands: sessionCommands, catalog: sessionCommands.map((n) => ({ name: n })) },
    }).onConflictDoNothing();
    return parentId;
  }

  test("a reply command in the SESSION catalog validates (session-authoritative, matching sessionId)", async () => {
    const parentId = await seedParentWithSession("ses_live", ["deploy"]); // NOT in the org cache
    const r = await post({ prompt: "/deploy", engine: "mock", parent_run_id: parentId, command: { name: "deploy", sessionId: "ses_live" } });
    expect(r.status).toBe(201);
    expect((await getRun(r.id!))?.commandName).toBe("deploy");
  });

  test("a command in the ORG cache but NOT the current session is REJECTED (session overrides org cache)", async () => {
    const parentId = await seedParentWithSession("ses_live2", ["deploy"]); // session has only `deploy`
    // `review` IS in the org cache (seeded above) but NOT in this session's catalog -> 400.
    const r = await post({ prompt: "/review", engine: "mock", parent_run_id: parentId, command: { name: "review", sessionId: "ses_live2" } });
    expect(r.status).toBe(400);
  });

  test("a WRONG/stale session id is REJECTED even for a valid command name (#3)", async () => {
    const parentId = await seedParentWithSession("ses_current", ["deploy"]);
    const r = await post({ prompt: "/deploy", engine: "mock", parent_run_id: parentId, command: { name: "deploy", sessionId: "ses_OLD" } });
    expect(r.status).toBe(400);
  });

  test("a session that advertised NONE (empty catalog) rejects any command (does not fall back to org cache)", async () => {
    const parentId = await seedParentWithSession("ses_empty", []); // advertised none
    const r = await post({ prompt: "/review", engine: "mock", parent_run_id: parentId, command: { name: "review", sessionId: "ses_empty" } });
    expect(r.status).toBe(400);
  });
});
