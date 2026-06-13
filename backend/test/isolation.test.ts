import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createOrgSession, json, type OrgSession } from "./helpers";

/**
 * Two-org tenancy isolation. Two real authenticated orgs (A, B). Every domain
 * detail/mutation/stream that org A owns must be invisible to org B — a cross-org
 * id resolves to 404/403, never another tenant's data. Positive controls confirm
 * the owner still gets 200, so the 404s prove scoping, not a broken route.
 */
describe("two-org isolation", () => {
  let A: OrgSession;
  let B: OrgSession;

  beforeAll(async () => {
    A = await createOrgSession("iso-a");
    B = await createOrgSession("iso-b");
    expect(A.orgId).not.toBe(B.orgId);
  });

  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  test("skills: B cannot read, run, patch, or delete A's skill", async () => {
    const created = await json<any>("/api/skills", {
      method: "POST",
      cookies: A.cookies,
      body: { name: `Iso Skill ${A.orgId}`, sections: { overview: [], procedure: [], verify: [] } },
    });
    expect(created.status).toBe(201);
    const skillId = created.body.id;

    // Positive control: A sees it in its list.
    const listA = await json<{ skills: any[] }>("/api/skills", { cookies: A.cookies });
    expect(listA.body.skills.some((s) => s.id === skillId)).toBe(true);

    // B's list excludes it, and every by-id op is a 404.
    const listB = await json<{ skills: any[] }>("/api/skills", { cookies: B.cookies });
    expect(listB.body.skills.some((s) => s.id === skillId)).toBe(false);

    const runB = await json(`/api/skills/${skillId}/run`, { method: "POST", cookies: B.cookies });
    expect(runB.status).toBe(404);
    const patchB = await json(`/api/skills/${skillId}`, {
      method: "PATCH",
      cookies: B.cookies,
      body: { description: "hijack" },
    });
    expect(patchB.status).toBe(404);
    const delB = await json(`/api/skills/${skillId}`, { method: "DELETE", cookies: B.cookies });
    expect(delB.status).toBe(404);

    // Positive control: A can still run it (untouched by B's attempts). The run
    // endpoint now creates a REAL run (prompt required) and bumps usage.
    const runA = await json<any>(`/api/skills/${skillId}/run`, {
      method: "POST",
      cookies: A.cookies,
      body: { prompt: "run my own skill", engine: "mock" },
    });
    expect(runA.status).toBe(201);
    expect(runA.body.id).toBeTruthy();
    const listA2 = await json<{ skills: any[] }>("/api/skills", { cookies: A.cookies });
    expect(listA2.body.skills.find((s) => s.id === skillId)?.usage_count).toBe(1);
  });

  test("knowledge: B cannot list, read, pin, or delete A's record", async () => {
    const ingest = await json<any>("/api/knowledge/ingest", {
      method: "POST",
      cookies: A.cookies,
      body: {
        meta: {
          source_type: "conversation",
          external_id: "iso-k-1",
          connector_instance_id: "test:iso",
        },
        text: "Org A secret: the incident bridge passphrase rotates every Monday at 0900 UTC.",
      },
    });
    expect(ingest.status).toBe(200);
    expect(ingest.body.status).toBe("stored");
    const recordId = ingest.body.id;

    // B's list + search never surface A's record.
    const listB = await json<any>("/api/knowledge", { cookies: B.cookies });
    expect(listB.body.records.some((r: any) => r.id === recordId)).toBe(false);
    const searchB = await json<any>("/api/knowledge/search", {
      method: "POST",
      cookies: B.cookies,
      body: { query: "incident bridge passphrase", k: 5 },
    });
    expect(searchB.body.results.some((r: any) => r.id === recordId)).toBe(false);

    // By-id mutations from B are 404.
    const pinB = await json(`/api/knowledge/${recordId}`, {
      method: "PATCH",
      cookies: B.cookies,
      body: { pinned: true },
    });
    expect(pinB.status).toBe(404);
    const delB = await json(`/api/knowledge/${recordId}`, { method: "DELETE", cookies: B.cookies });
    expect(delB.status).toBe(404);

    // Positive control: A still owns it.
    const listA = await json<any>("/api/knowledge", { cookies: A.cookies });
    expect(listA.body.records.some((r: any) => r.id === recordId)).toBe(true);
  });

  test("runs: B cannot read detail or the SSE stream of A's run", async () => {
    const created = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: A.cookies,
      body: { prompt: "org A private run" },
    });
    expect(created.status).toBe(201);
    const runId = created.body.id;

    // Positive control: A reads its own run.
    const detailA = await json<any>(`/api/runs/${runId}`, { cookies: A.cookies });
    expect(detailA.status).toBe(200);
    expect(detailA.body.id).toBe(runId);

    // B is 404 on both the detail and the event stream.
    const detailB = await json(`/api/runs/${runId}`, { cookies: B.cookies });
    expect(detailB.status).toBe(404);
    const eventsB = await json(`/api/runs/${runId}/events`, { cookies: B.cookies });
    expect(eventsB.status).toBe(404);

    // And B's run list omits it.
    const listB = await json<{ runs: any[] }>("/api/runs", { cookies: B.cookies });
    expect(listB.body.runs.some((r) => r.id === runId)).toBe(false);
  });
});
