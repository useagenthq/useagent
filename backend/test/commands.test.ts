import { describe, expect, test } from "bun:test";
import { createOrgSession, fetchApi, json, uid } from "./helpers";

// Durable-command idempotency on POST /api/runs. Runs use the fast scripted
// `mock` engine (no sandbox), so these are pure in-process API assertions.

async function post(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  cookies?: string,
) {
  return json<{ id?: string; error?: string }>("/api/runs", {
    method: "POST",
    body,
    headers,
    ...(cookies ? { cookies } : {}),
  });
}

describe("durable commands / idempotency", () => {
  test("same Idempotency-Key twice → ONE run, second returns the original id (200)", async () => {
    // Isolated org so a run count is unambiguous.
    const s = await createOrgSession("idem");
    const key = uid("idem-key");

    const first = await post({ prompt: "durable please" }, { "Idempotency-Key": key }, s.cookies);
    expect(first.status).toBe(201);
    const runId = first.body.id!;
    expect(runId).toBeDefined();

    // Replay with the SAME key + SAME body — the classic lost-response retry.
    const replay = await post({ prompt: "durable please" }, { "Idempotency-Key": key }, s.cookies);
    expect(replay.status).toBe(200); // replay, not a fresh 201
    expect(replay.body.id).toBe(runId); // the ORIGINAL run id

    // Exactly one run exists for this org (the replay started no new work).
    const list = await json<{ runs: any[] }>("/api/runs?all=1", { cookies: s.cookies });
    const mine = list.body.runs.filter((r) => r.id === runId);
    expect(mine.length).toBe(1);
    expect(list.body.runs.length).toBe(1);
  });

  test("ambiguous retry: same key, DIFFERENT body → 409 idempotency_key_reused", async () => {
    const s = await createOrgSession("idem-ambig");
    const key = uid("idem-key");

    const first = await post({ prompt: "the real intent" }, { "Idempotency-Key": key }, s.cookies);
    expect(first.status).toBe(201);
    const runId = first.body.id!;

    // Same key, a DIFFERENT prompt — the server must refuse to guess.
    const conflict = await post(
      { prompt: "a totally different ask" },
      { "Idempotency-Key": key },
      s.cookies,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("idempotency_key_reused");

    // The conflicting request created NO run — still exactly one.
    const list = await json<{ runs: any[] }>("/api/runs?all=1", { cookies: s.cookies });
    expect(list.body.runs.length).toBe(1);
    expect(list.body.runs[0].id).toBe(runId);
  });

  test("distinct keys → distinct runs; no key → new run every call (unchanged path)", async () => {
    const s = await createOrgSession("idem-distinct");

    const a = await post({ prompt: "one" }, { "Idempotency-Key": uid("k") }, s.cookies);
    const b = await post({ prompt: "two" }, { "Idempotency-Key": uid("k") }, s.cookies);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);

    // Un-keyed calls are never deduplicated — two calls, two runs.
    const c = await post({ prompt: "three" }, {}, s.cookies);
    const d = await post({ prompt: "three" }, {}, s.cookies);
    expect(c.status).toBe(201);
    expect(d.status).toBe(201);
    expect(c.body.id).not.toBe(d.body.id);

    const list = await json<{ runs: any[] }>("/api/runs?all=1", { cookies: s.cookies });
    expect(list.body.runs.length).toBe(4);
  });

  test("same key across DIFFERENT orgs does not collide (per-tenant idempotency)", async () => {
    const s1 = await createOrgSession("idem-org1");
    const s2 = await createOrgSession("idem-org2");
    const key = "shared-key-value";

    const r1 = await post({ prompt: "org1 work" }, { "Idempotency-Key": key }, s1.cookies);
    const r2 = await post({ prompt: "org2 work" }, { "Idempotency-Key": key }, s2.cookies);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201); // NOT a replay — different tenant
    expect(r1.body.id).not.toBe(r2.body.id);
  });
});
