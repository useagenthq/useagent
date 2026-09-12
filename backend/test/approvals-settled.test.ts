import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { gatewayApprovalRequests, providerEvents, runs } from "../src/db/schema";
import { executeApprovalRequestToolLocal } from "../src/knowledge/gateway/approval-request-tools";
import {
  approvalDecisionPrompt,
  createApprovalRequest,
} from "../src/knowledge/gateway/approval-requests";
import type { ToolTokenClaims } from "../src/knowledge/gateway/token";
import { createOrgSession, json, waitFor } from "./helpers";

// The approval_request contract tells the agent to end its turn and wait for
// the person. A pending request therefore usually belongs to a run that has
// already SETTLED; deciding it must still reach the agent: through a
// follow-up turn on the thread that carries the decision, with the one-shot
// capability bound to that turn.

const previousFlag = process.env.BOTS;
beforeAll(() => {
  process.env.BOTS = "1";
});
afterAll(() => {
  if (previousFlag === undefined) delete process.env.BOTS;
  else process.env.BOTS = previousFlag;
});

interface RunBody {
  id: string;
  status: string;
  prompt: string;
  user_id: string | null;
  thread_id: string;
  parent_run_id: string | null;
}

async function settledRun(cookies: string, id: string): Promise<RunBody> {
  return waitFor(async () => {
    const run = await json<RunBody>(`/api/runs/${id}`, { cookies });
    return run.body.status === "completed" || run.body.status === "failed" ? run.body : null;
  });
}

function claimsFor(orgId: string, userId: string, threadId: string, runId: string): ToolTokenClaims {
  return { orgId, userId, threadId, runId, scope: "run", exp: Date.now() + 60_000 };
}

describe("approvals on settled runs", () => {
  test("a settled bot-thread request is decided through a follow-up turn that carries the decision", async () => {
    const { cookies, orgId } = await createOrgSession("approvals-settled");
    const created = await json<{ bot: { id: string } }>("/api/bots", {
      method: "POST",
      cookies,
      body: { name: "Planner", title: "Plans the night", rules: "Ask before enabling anything.", engine: "mock" },
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const first = await json<{ id: string }>(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      cookies,
      body: { text: "Enable the nightly check." },
    });
    expect(first.status).toBe(201);
    const root = await settledRun(cookies, first.body.id);
    const userId = root.user_id;
    if (!userId) throw new Error("expected the first message to carry its user");

    const { request } = await createApprovalRequest({
      orgId,
      runId: root.id,
      threadId: root.thread_id,
      toolName: "automation_update",
      arguments: { id: "auto-1", enabled: true },
    });

    // Listed on the thread whether or not a run is live: the card renders there.
    const listed = await json<{ requests: { id: string; run_id: string }[] }>(
      `/api/gateway/approvals/requests?threadId=${root.thread_id}`,
      { cookies },
    );
    expect(listed.body.requests.map((r) => r.id)).toEqual([request.id]);

    const approve = await json<{ id: string; status: string; follow_up_run_id?: string }>(
      `/api/gateway/approvals/requests/${request.id}/approve`,
      { method: "POST", cookies },
    );
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("approved");
    const followUpId = approve.body.follow_up_run_id;
    if (!followUpId) throw new Error("expected a follow-up turn");

    // The follow-up chains under the thread head as the person's turn and tells
    // the bot what was decided and how to continue.
    const followUp = await json<RunBody>(`/api/runs/${followUpId}`, { cookies });
    expect(followUp.body.thread_id).toBe(root.thread_id);
    expect(followUp.body.parent_run_id).toBe(root.id);
    expect(followUp.body.user_id).toBe(userId);
    expect(followUp.body.prompt).toBe(approvalDecisionPrompt(request, "approve", null));
    expect(followUp.body.prompt).toContain(request.id);
    expect(followUp.body.prompt).toContain("approval_poll");

    // The one-shot capability is bound to the follow-up turn: its poll receives
    // it exactly once; the settled run's poll never does.
    const [row] = await db
      .select()
      .from(gatewayApprovalRequests)
      .where(eq(gatewayApprovalRequests.id, request.id));
    expect(row?.runId).toBe(followUpId);
    expect(row?.capability).toBeTruthy();
    const stale = await executeApprovalRequestToolLocal(
      claimsFor(orgId, userId, root.thread_id, root.id),
      "approval_poll",
      { id: request.id },
    );
    expect(stale.isError).toBe(true);
    const handout = await executeApprovalRequestToolLocal(
      claimsFor(orgId, userId, root.thread_id, followUpId),
      "approval_poll",
      { id: request.id },
    );
    expect(handout.isError).toBeUndefined();
    expect(handout.structuredContent).toMatchObject({ status: "approved", tool_name: "automation_update" });
    expect(typeof handout.structuredContent?.approval_capability).toBe("string");

    // The card stays on the turn that asked: the resolution lands on that run's timeline.
    const resolved = await db
      .select({ id: providerEvents.id, runId: providerEvents.runId })
      .from(providerEvents)
      .where(and(eq(providerEvents.runId, root.id), eq(providerEvents.eventType, "gateway.approval.resolved")));
    expect(resolved).toHaveLength(1);

    // Deciding it again is refused as already resolved, and no list entry remains.
    const again = await json<{ error: string }>(`/api/gateway/approvals/requests/${request.id}/deny`, {
      method: "POST",
      cookies,
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("request_not_pending");
    await settledRun(cookies, followUpId);
  });

  test("a denial starts a follow-up that carries the reason", async () => {
    const { cookies, orgId } = await createOrgSession("approvals-denied");
    const created = await json<{ bot: { id: string } }>("/api/bots", {
      method: "POST",
      cookies,
      body: { name: "Digest", title: "Sends the digest", rules: "", engine: "mock" },
    });
    const first = await json<{ id: string }>(`/api/bots/${created.body.bot.id}/messages`, {
      method: "POST",
      cookies,
      body: { text: "Send tonight's digest." },
    });
    const root = await settledRun(cookies, first.body.id);
    const { request } = await createApprovalRequest({
      orgId,
      runId: root.id,
      threadId: root.thread_id,
      toolName: "automation_run_now",
      arguments: { id: "auto-2" },
    });
    const deny = await json<{ status: string; follow_up_run_id?: string }>(
      `/api/gateway/approvals/requests/${request.id}/deny`,
      { method: "POST", cookies, body: { reason: "Not tonight, the list is stale." } },
    );
    expect(deny.status).toBe(200);
    expect(deny.body.status).toBe("denied");
    const followUp = await json<RunBody>(`/api/runs/${deny.body.follow_up_run_id}`, { cookies });
    expect(followUp.body.parent_run_id).toBe(root.id);
    expect(followUp.body.prompt).toBe(approvalDecisionPrompt(request, "deny", "Not tonight, the list is stale."));
    expect(followUp.body.prompt).toContain("Not tonight, the list is stale.");
    // A denied request polled from the follow-up reads as denied, never as another run's.
    const polled = await executeApprovalRequestToolLocal(
      claimsFor(orgId, root.user_id ?? "", root.thread_id, followUp.body.id),
      "approval_poll",
      { id: request.id },
    );
    expect(polled.structuredContent).toMatchObject({ status: "denied" });
    await settledRun(cookies, followUp.body.id);
  });

  test("an ordinary thread's settled request is decided the same way; a run that never started is not", async () => {
    const { cookies, orgId } = await createOrgSession("approvals-plain");
    const plain = await json<{ id: string }>("/api/runs", { method: "POST", cookies, body: { prompt: "Plain run.", engine: "mock" } });
    expect(plain.status).toBe(201);
    const root = await settledRun(cookies, plain.body.id);
    const { request } = await createApprovalRequest({
      orgId,
      runId: root.id,
      threadId: root.thread_id,
      toolName: "automation_delete",
      arguments: { id: "auto-3" },
    });
    const approve = await json<{ status: string; follow_up_run_id?: string }>(
      `/api/gateway/approvals/requests/${request.id}/approve`,
      { method: "POST", cookies },
    );
    expect(approve.status).toBe(200);
    expect(approve.body.follow_up_run_id).toBeTruthy();
    const followUp = await json<RunBody>(`/api/runs/${approve.body.follow_up_run_id}`, { cookies });
    expect(followUp.body.thread_id).toBe(root.thread_id);
    await settledRun(cookies, followUp.body.id);

    // A queued run has not asked anything yet: nothing to decide, nothing to continue.
    const queuedId = crypto.randomUUID();
    await db.insert(runs).values({
      id: queuedId,
      orgId,
      userId: root.user_id,
      threadId: queuedId,
      status: "queued",
      prompt: "not started",
      model: "mock",
      engine: "mock",
      memoryScope: "org",
    });
    const { request: early } = await createApprovalRequest({
      orgId,
      runId: queuedId,
      threadId: queuedId,
      toolName: "automation_delete",
      arguments: { id: "auto-4" },
    });
    const refused = await json<{ error: string }>(`/api/gateway/approvals/requests/${early.id}/approve`, {
      method: "POST",
      cookies,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("run_not_active");
    await db.delete(gatewayApprovalRequests).where(eq(gatewayApprovalRequests.id, early.id));
    await db.delete(providerEvents).where(eq(providerEvents.runId, queuedId));
    await db.delete(runs).where(eq(runs.id, queuedId));
  });
});
