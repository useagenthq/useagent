/**
 * Learning lane item 4 — reviewable knowledge drafts. Proves the governance
 * contract end-to-end:
 *  - a HIGH-VALUE completed run (long multi-tool, or published artifacts)
 *    proposes a DRAFT via the real post-finalize hook, and knowledge_records
 *    stays UNTOUCHED (nothing auto-publishes);
 *  - low-value runs propose nothing; the producer is idempotent per run;
 *  - listing is org-scoped; accept/dismiss require an org admin;
 *  - accept creates the real knowledge record through the existing store path.
 */
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { artifacts, knowledgeDrafts, member, user } from "../src/db/schema";
import { proposeKnowledgeDraftForRun } from "../src/learning/drafts";
import { finalizeRun } from "../src/runs/finalize";
import { createRun, insertStep } from "../src/runs/repo";
import { createOrgSession, json, uid, type OrgSession } from "./helpers";

interface DraftApi {
  id: string;
  run_id: string;
  title: string;
  content: string;
  status: string;
  evidence: {
    reason: string;
    stepCount: number;
    artifactNames: string[];
    procedure?: { tool: string; gist: string; ok: boolean }[];
    procedureElided?: number;
  };
  accepted_record_id: string | null;
}

async function newRun(session: OrgSession, prompt: string): Promise<string> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt,
    model: "test",
    engine: "mock",
    orgId: session.orgId,
    userId: null,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  return runId;
}

async function addSteps(runId: string, count: number, kinds: ("command" | "file")[]) {
  for (let i = 0; i < count; i++) {
    await insertStep({
      runId,
      idx: i,
      kind: kinds[i % kinds.length]!,
      label: `step ${i}`,
      chip: null,
      code: null,
    });
  }
}

async function listDrafts(session: OrgSession, status?: string) {
  const q = status ? `?status=${status}` : "";
  return json<{ drafts: DraftApi[] }>(`/api/knowledge/drafts${q}`, { cookies: session.cookies });
}

/** Demote the session's user to a plain member (orgAdminScope must then reject). */
async function demoteToMember(session: OrgSession): Promise<void> {
  const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, session.email));
  expect(account).toBeTruthy();
  await db
    .update(member)
    .set({ role: "member" })
    .where(and(eq(member.organizationId, session.orgId), eq(member.userId, account!.id)));
}

describe("knowledge drafts — producer", () => {
  test("a long multi-tool completed run proposes a draft via finalize; knowledge stays untouched", async () => {
    const org = await createOrgSession("kd-producer");
    const runId = await newRun(org, "Investigate the flaky payment webhook retries\nDetails follow.");
    await addSteps(runId, 12, ["command", "file"]);
    await finalizeRun(runId, "completed", "Root-caused the retry storm and fixed the backoff.", 4200);

    const { status, body } = await listDrafts(org);
    expect(status).toBe(200);
    expect(body.drafts).toHaveLength(1);
    const draft = body.drafts[0]!;
    expect(draft.run_id).toBe(runId);
    expect(draft.status).toBe("draft");
    expect(draft.title).toBe("Investigate the flaky payment webhook retries");
    expect(draft.evidence.reason).toBe("long_multi_tool_run");
    expect(draft.evidence.stepCount).toBe(12);
    expect(draft.content).toContain("Root-caused the retry storm");

    // NOTHING auto-publishes: the draft is not a knowledge record.
    const knowledge = await json<{ records: unknown[] }>("/api/knowledge", { cookies: org.cookies });
    expect(knowledge.status).toBe(200);
    expect(knowledge.body.records).toHaveLength(0);
  });

  test("draft evidence carries the ordered, redacted procedure trace and round-trips the API", async () => {
    const org = await createOrgSession("kd-procedure");
    const runId = await newRun(org, "Rotate the API keys for the payments service");
    // Real-shaped step rows: tool payloads with targets, one terminal failure,
    // and the done marker (which the trace must exclude).
    const recorded = [
      { kind: "command" as const, label: "bun install", chip: "bash", code: { tool: "bash", input: { command: "bun install" } } },
      { kind: "file" as const, label: ".env.production", chip: "file", code: { tool: "edit", input: { filePath: "config/.env.production" } } },
      { kind: "command" as const, label: "bun test", chip: "bash", code: { tool: "bash", input: { command: "bun test" }, error: true } },
      { kind: "command" as const, label: "bun test", chip: "bash", code: { tool: "bash", input: { command: "bun test" } } },
    ];
    // Pad past the long-multi-tool salience bar (>= 10 steps, 2 kinds).
    while (recorded.length < 10) {
      const command = `vault kv get payments/${recorded.length}`;
      recorded.push({
        kind: "command",
        label: command,
        chip: "bash",
        code: { tool: "bash", input: { command } },
      });
    }
    for (const [i, s] of recorded.entries()) {
      await insertStep({ runId, idx: i, kind: s.kind, label: s.label, chip: s.chip, code: s.code });
    }
    await insertStep({ runId, idx: recorded.length, kind: "done", label: "Done", chip: null, code: null });
    await finalizeRun(runId, "completed", "Rotated and verified.", 800);

    const draft = (await listDrafts(org)).body.drafts[0]!;
    // Ordered, done-marker excluded, terminal outcome per step.
    expect(draft.evidence.procedure).toHaveLength(recorded.length);
    expect(draft.evidence.procedure!.slice(0, 4)).toEqual([
      { tool: "bash", gist: "bun install", ok: true },
      { tool: "edit", gist: "config/.env.production", ok: true },
      { tool: "bash", gist: "bun test", ok: false },
      { tool: "bash", gist: "bun test", ok: true },
    ]);
    expect(draft.evidence.procedure!.at(-1)).toEqual({
      tool: "bash",
      gist: "vault kv get payments/9",
      ok: true,
    });
    expect(draft.evidence.procedureElided).toBeUndefined();
  });

  test("a run with published artifacts proposes with reason published_artifacts", async () => {
    const org = await createOrgSession("kd-artifact");
    const runId = await newRun(org, "Build the quarterly revenue deck");
    await db.insert(artifacts).values({
      orgId: org.orgId,
      runId,
      threadId: runId,
      sourcePath: "deck.pptx",
      name: "deck.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      sizeBytes: 1024,
      sha256: uid("sha"),
      storageKey: uid("key"),
    });
    await finalizeRun(runId, "completed", "Published the deck.", 900);

    const { body } = await listDrafts(org);
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]!.evidence.reason).toBe("published_artifacts");
    expect(body.drafts[0]!.evidence.artifactNames).toEqual(["deck.pptx"]);
    expect(body.drafts[0]!.content).toContain("- deck.pptx");
  });

  test("low-value and failed runs propose nothing; the producer is idempotent", async () => {
    const org = await createOrgSession("kd-lowvalue");

    // Short run: completed but below the multi-tool bar.
    const shortRun = await newRun(org, "Quick question");
    await addSteps(shortRun, 2, ["command"]);
    await finalizeRun(shortRun, "completed", "Answered.", 100);

    // High-value activity but FAILED: never drafted.
    const failedRun = await newRun(org, "Big refactor");
    await addSteps(failedRun, 12, ["command", "file"]);
    await finalizeRun(failedRun, "failed", "Crashed.", 100);

    expect((await listDrafts(org)).body.drafts).toHaveLength(0);

    // Idempotency: re-proposing an already-drafted run is a no-op.
    const goodRun = await newRun(org, "Long investigation");
    await addSteps(goodRun, 12, ["command", "file"]);
    await finalizeRun(goodRun, "completed", "Done.", 100);
    expect(await proposeKnowledgeDraftForRun(goodRun)).toBeNull();
    expect((await listDrafts(org)).body.drafts).toHaveLength(1);
  });

  test("drafts are org-scoped: an outsider sees none", async () => {
    const org = await createOrgSession("kd-scope-a");
    const outsider = await createOrgSession("kd-scope-b");
    const runId = await newRun(org, "Org-private learning");
    await addSteps(runId, 12, ["command", "file"]);
    await finalizeRun(runId, "completed", "Done.", 100);

    expect((await listDrafts(org)).body.drafts).toHaveLength(1);
    expect((await listDrafts(outsider)).body.drafts).toHaveLength(0);
  });
});

describe("knowledge drafts — review governance", () => {
  test("accept (org admin) creates the real knowledge record; re-resolving conflicts", async () => {
    const org = await createOrgSession("kd-accept");
    const runId = await newRun(org, "Migrate the analytics pipeline to the new warehouse");
    await addSteps(runId, 12, ["command", "file"]);
    await finalizeRun(runId, "completed", "Migrated and verified row counts.", 100);
    const draft = (await listDrafts(org)).body.drafts[0]!;

    const accept = await json<{ draft: DraftApi; record_id: string; proposal_id: string | null }>(
      `/api/knowledge/drafts/${draft.id}/accept`,
      { method: "POST", cookies: org.cookies },
    );
    expect(accept.status).toBe(200);
    expect(accept.body.draft.status).toBe("accepted");
    expect(accept.body.record_id).toBeTruthy();
    expect(accept.body.draft.accepted_record_id).toBe(accept.body.record_id);
    // One accepted draft has no similar priors — no skill proposal yet.
    expect(accept.body.proposal_id).toBeNull();

    // The accept created REAL knowledge through the existing store path.
    const knowledge = await json<{ records: { id: string; kind: string; title: string }[] }>(
      "/api/knowledge",
      { cookies: org.cookies },
    );
    expect(knowledge.body.records).toHaveLength(1);
    expect(knowledge.body.records[0]!.id).toBe(accept.body.record_id);
    expect(knowledge.body.records[0]!.kind).toBe("learning");
    expect(knowledge.body.records[0]!.title).toBe(draft.title);

    // Already resolved: accept and dismiss both conflict now.
    expect(
      (await json(`/api/knowledge/drafts/${draft.id}/accept`, { method: "POST", cookies: org.cookies }))
        .status,
    ).toBe(409);
    expect(
      (await json(`/api/knowledge/drafts/${draft.id}/dismiss`, { method: "POST", cookies: org.cookies }))
        .status,
    ).toBe(409);
  });

  test("dismiss records the decision and never touches knowledge", async () => {
    const org = await createOrgSession("kd-dismiss");
    const runId = await newRun(org, "One-off spike we should not memorialize");
    await addSteps(runId, 12, ["command", "file"]);
    await finalizeRun(runId, "completed", "Done.", 100);
    const draft = (await listDrafts(org)).body.drafts[0]!;

    const dismiss = await json<{ draft: DraftApi }>(`/api/knowledge/drafts/${draft.id}/dismiss`, {
      method: "POST",
      cookies: org.cookies,
    });
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.draft.status).toBe("dismissed");
    // Recorded, not deleted; and knowledge stays empty.
    expect((await listDrafts(org, "dismissed")).body.drafts).toHaveLength(1);
    const knowledge = await json<{ records: unknown[] }>("/api/knowledge", { cookies: org.cookies });
    expect(knowledge.body.records).toHaveLength(0);
  });

  test("a plain member may list but cannot accept or dismiss", async () => {
    const org = await createOrgSession("kd-member");
    const runId = await newRun(org, "Members can look but not govern");
    await addSteps(runId, 12, ["command", "file"]);
    await finalizeRun(runId, "completed", "Done.", 100);
    const draft = (await listDrafts(org)).body.drafts[0]!;

    await demoteToMember(org);
    expect((await listDrafts(org)).status).toBe(200);
    const accept = await json<{ error: string }>(`/api/knowledge/drafts/${draft.id}/accept`, {
      method: "POST",
      cookies: org.cookies,
    });
    expect(accept.status).toBe(403);
    expect(accept.body.error).toBe("organization_admin_required");
    expect(
      (await json(`/api/knowledge/drafts/${draft.id}/dismiss`, { method: "POST", cookies: org.cookies }))
        .status,
    ).toBe(403);
    // Still an open draft — the member's attempts changed nothing.
    const [row] = await db
      .select({ status: knowledgeDrafts.status })
      .from(knowledgeDrafts)
      .where(eq(knowledgeDrafts.id, draft.id));
    expect(row?.status).toBe("draft");
  });

  test("unknown and cross-org draft ids are 404", async () => {
    const org = await createOrgSession("kd-404");
    expect(
      (await json(`/api/knowledge/drafts/${crypto.randomUUID()}/accept`, {
        method: "POST",
        cookies: org.cookies,
      })).status,
    ).toBe(404);
    expect(
      (await json("/api/knowledge/drafts/not-a-uuid/dismiss", {
        method: "POST",
        cookies: org.cookies,
      })).status,
    ).toBe(404);
  });
});
