// Phase 3 (route integration): POST /api/runs validates a typed native-command intent against
// the active authoritative catalog BEFORE it may skip context. A validated intent stores the
// command name + the verbatim `/name args` prompt (built once in the backend); an unknown or
// malformed intent is a 400; a plain prompt that merely starts with "/" (no intent) stays a
// normal prompt with commandName null. DB-backed (skynet_test), dev-org scoped.
import { describe, expect, test, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { commandsCatalog, runs } from "../src/db/schema";
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
