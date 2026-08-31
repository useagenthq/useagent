import { describe, expect, test } from "bun:test";
import { createOrgSession, fetchApi, json, uid } from "./helpers";
import { acceptRunCommand, type RunCommandIntent } from "../src/commands";
import { RUN_PROMPT_MAX_CHARS } from "../src/commands/prompt-policy";

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
  test("shared acceptance rejects oversized prompts from every ingress", async () => {
    const prompt = "x".repeat(RUN_PROMPT_MAX_CHARS + 1);
    const runId = crypto.randomUUID();
    await expect(acceptRunCommand({
      idempotencyKey: null,
      orgId: `org-${crypto.randomUUID()}`,
      actorId: null,
      run: {
        id: runId,
        prompt,
        model: "mock-model",
        engine: "mock",
        parentRunId: null,
        threadId: runId,
        repos: [],
        memoryScope: "org",
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    })).rejects.toThrow("run prompt exceeds the accepted size limit");
  });

  test("an accepted PR request replays before unavailable GitHub preflight", async () => {
    const s = await createOrgSession("idem-pr-down");
    const key = uid("idem-pr-down");
    const prompt = "inspect https://github.com/acme/api/pull/42";
    const runId = crypto.randomUUID();
    const intent: RunCommandIntent = {
      prompt,
      model: null,
      engine: "mock",
      parentRunId: null,
      requestedRepos: [],
      requestedResources: [],
      attachmentIds: [],
      memoryScope: null,
      skillId: null,
      skillVersion: null,
      commandName: null,
      commandProvider: null,
      commandSessionId: null,
      commandCatalogRevision: null,
    };
    expect(await acceptRunCommand({
      idempotencyKey: key,
      orgId: s.orgId,
      actorId: null,
      intent,
      run: {
        id: runId,
        prompt,
        model: "claude-opus-5",
        engine: "mock",
        parentRunId: null,
        threadId: runId,
        repos: ["acme/api:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        resolvedResources: [],
        memoryScope: "org",
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    })).toMatchObject({ status: "created", runId });

    // This org has no GitHub connection. The route can return 200 only if it
    // recognizes the durable raw intent before resolveRunIntake consults it.
    const replay = await post(
      { prompt, engine: "mock" },
      { "Idempotency-Key": key },
      s.cookies,
    );
    expect(replay).toEqual({ status: 200, body: { id: runId } });
  });

  test("an accepted retry bypasses later provider-readiness failure, but changed intent conflicts", async () => {
    const s = await createOrgSession("idem-provider-down");
    const key = uid("idem-provider-down");
    const prompt = "continue the codex task";
    const model = "gpt-5.6-sol";
    const runId = crypto.randomUUID();
    const intent: RunCommandIntent = {
      prompt,
      model,
      engine: "codex",
      parentRunId: null,
      requestedRepos: [],
      requestedResources: [],
      attachmentIds: [],
      memoryScope: null,
      skillId: null,
      skillVersion: null,
      commandName: null,
      commandProvider: null,
      commandSessionId: null,
      commandCatalogRevision: null,
    };
    expect(await acceptRunCommand({
      idempotencyKey: key,
      orgId: s.orgId,
      actorId: null,
      intent,
      run: {
        id: runId,
        prompt,
        model,
        engine: "codex",
        parentRunId: null,
        threadId: runId,
        repos: [],
        resolvedResources: [],
        memoryScope: "org",
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    })).toMatchObject({ status: "created", runId });

    const previous = process.env.PROVIDER_HEALTH_OPENAI;
    process.env.PROVIDER_HEALTH_OPENAI = "failed";
    try {
      expect(await post(
        { prompt, engine: "codex", model },
        { "Idempotency-Key": key },
        s.cookies,
      )).toEqual({ status: 200, body: { id: runId } });
      expect((await post(
        { prompt: `${prompt} changed`, engine: "codex", model },
        { "Idempotency-Key": key },
        s.cookies,
      )).status).toBe(409);
    } finally {
      if (previous === undefined) delete process.env.PROVIDER_HEALTH_OPENAI;
      else process.env.PROVIDER_HEALTH_OPENAI = previous;
    }
  });

  test("an accepted run with a selected skill replays after the skill is deleted", async () => {
    const s = await createOrgSession("idem-deleted-skill");
    const skill = await json<{ id: string }>("/api/skills", {
      method: "POST",
      body: { name: `Disposable ${uid("skill")}` },
      cookies: s.cookies,
    });
    expect(skill.status).toBe(201);
    const key = uid("idem-deleted-skill");
    const body = {
      prompt: "apply the selected skill",
      engine: "mock",
      skill: { id: skill.body.id },
    };
    const first = await post(body, { "Idempotency-Key": key }, s.cookies);
    expect(first.status).toBe(201);
    expect((await json(`/api/skills/${skill.body.id}`, {
      method: "DELETE",
      cookies: s.cookies,
    })).status).toBe(200);

    expect(await post(body, { "Idempotency-Key": key }, s.cookies)).toEqual({
      status: 200,
      body: { id: first.body.id },
    });
  });

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

  test("forged public internal-looking identifiers stay product origin and capture normally", async () => {
    const s = await createOrgSession("origin");

    const forged = await post(
      { prompt: "parity probe" },
      { "Idempotency-Key": `e2e-${crypto.randomUUID()}` },
      s.cookies,
    );
    expect(forged.status).toBe(201);
    const { db } = await import("../src/db/client");
    const { sql } = await import("drizzle-orm");
    const [forgedRow] = (await db.execute(
      sql`select origin from runs where id = ${forged.body.id!}`,
    )) as unknown as Array<{ origin: string | null }>;
    expect(forgedRow?.origin).toBeNull();

    const product = await post({ prompt: "real work" }, { "Idempotency-Key": uid("key") }, s.cookies);
    expect(product.status).toBe(201);
    const [productRow] = (await db.execute(
      sql`select origin from runs where id = ${product.body.id!}`,
    )) as unknown as Array<{ origin: string | null }>;
    expect(productRow?.origin).toBeNull();
  });

  test("concurrent same-key root submissions resolve after the losing transaction rolls back", async () => {
    const s = await createOrgSession("idem-concurrent");
    const key = uid("idem-key");

    const responses = await Promise.all([
      post({ prompt: "one durable intent" }, { "Idempotency-Key": key }, s.cookies),
      post({ prompt: "one durable intent" }, { "Idempotency-Key": key }, s.cookies),
    ]);

    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 201]);
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);

    const list = await json<{ runs: Array<{ id: string }> }>("/api/runs?all=1", {
      cookies: s.cookies,
    });
    expect(list.body.runs).toHaveLength(1);
    expect(list.body.runs[0]?.id).toBe(responses[0]?.body.id);
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
