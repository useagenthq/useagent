import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import server from "../../index";
import { db } from "../../db/client";
import { gatewayApprovalRequests, providerEvents, runs } from "../../db/schema";
import { getDevContext } from "../../seed";
import { consumeApprovalCapability } from "./approval-capability";
import {
  approvalRequestSummary,
  approveApprovalRequest,
  createApprovalRequest,
  denyApprovalRequest,
  getApprovalRequestForOrg,
  takeApprovalCapability,
} from "./approval-requests";
import { executeApprovalRequestToolLocal } from "./approval-request-tools";
import { executeRegisteredGatewayTool } from "./operation-registry";
import type { ToolTokenClaims } from "./token";

const BASE = "http://localhost:3211";
const ORIGIN = "http://localhost:3200";

const createdRunIds = new Set<string>();

afterEach(async () => {
  for (const id of createdRunIds) {
    await db.delete(providerEvents).where(eq(providerEvents.runId, id));
    await db.delete(runs).where(eq(runs.id, id));
  }
  createdRunIds.clear();
});

async function insertRun(input: {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string | null;
  readonly threadId: string;
  readonly status: "running" | "completed";
}): Promise<void> {
  createdRunIds.add(input.id);
  await db.insert(runs).values({
    ...input,
    prompt: "approval lane test",
    model: "gpt-5",
    engine: "opencode",
    memoryScope: "org",
  });
}

interface Actor {
  readonly claims: ToolTokenClaims;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly threadId: string;
}

async function runningActor(overrides: {
  readonly orgId?: string;
  readonly userId?: string;
  readonly status?: "running" | "completed";
} = {}): Promise<Actor> {
  const orgId = overrides.orgId ?? `org-${crypto.randomUUID()}`;
  const userId = overrides.userId ?? `user-${crypto.randomUUID()}`;
  const threadId = `thread-${crypto.randomUUID()}`;
  const runId = `run-${crypto.randomUUID()}`;
  await insertRun({ id: runId, orgId, userId, threadId, status: overrides.status ?? "running" });
  return {
    claims: { orgId, userId, threadId, runId, scope: "run", exp: Date.now() + 60_000 },
    orgId,
    userId,
    runId,
    threadId,
  };
}

function structured(result: { structuredContent?: Readonly<Record<string, unknown>> }): Record<string, unknown> {
  if (!result.structuredContent) throw new Error("expected structuredContent");
  return { ...result.structuredContent };
}

function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return Promise.resolve(
    server.fetch(
      new Request(BASE + path, {
        method: init.method ?? "GET",
        headers: {
          origin: ORIGIN,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
    ),
  );
}

describe("gateway approval-request lane (#77)", () => {
  test("approval_request records a durable pending request, emits the timeline card event, and dedupes retries", async () => {
    const actor = await runningActor();
    const first = await executeApprovalRequestToolLocal(actor.claims, "approval_request", {
      toolName: "automation_delete",
      arguments: { id: "automation-1" },
    });
    expect(first.isError).toBeUndefined();
    const firstContent = structured(first);
    expect(firstContent.status).toBe("pending");
    expect(firstContent.already_pending).toBe(false);
    const requestId = firstContent.approval_request_id as string;
    expect(first.content[0]?.text).toContain("approve or deny it in the useAgent session view");

    const [row] = await db
      .select()
      .from(gatewayApprovalRequests)
      .where(eq(gatewayApprovalRequests.id, requestId));
    expect(row).toMatchObject({
      orgId: actor.orgId,
      runId: actor.runId,
      threadId: actor.threadId,
      toolName: "automation_delete",
      arguments: { id: "automation-1" },
      status: "pending",
      capability: null,
      resolvedBy: null,
    });

    const events = await db
      .select()
      .from(providerEvents)
      .where(
        and(
          eq(providerEvents.runId, actor.runId),
          eq(providerEvents.eventType, "gateway.approval.requested"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.provider).toBe("skynet-gateway");
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({
      requestId,
      toolName: "automation_delete",
      status: "pending",
    });

    // An agent retry with the exact same operation returns the SAME pending
    // request instead of stacking duplicate cards.
    const retry = await executeApprovalRequestToolLocal(actor.claims, "approval_request", {
      toolName: "automation_delete",
      arguments: { id: "automation-1" },
    });
    expect(structured(retry)).toMatchObject({
      approval_request_id: requestId,
      already_pending: true,
    });
  });

  test("approval_request validates the target: registry-gated tools only, complete arguments, no embedded capability", async () => {
    const actor = await runningActor();
    const ungated = await executeApprovalRequestToolLocal(actor.claims, "approval_request", {
      toolName: "automation_list",
      arguments: {},
    });
    expect(ungated.isError).toBe(true);
    expect(ungated.content[0]?.text).toContain("does not require approval");

    const incomplete = await executeApprovalRequestToolLocal(actor.claims, "approval_request", {
      toolName: "automation_delete",
      arguments: {},
    });
    expect(incomplete.isError).toBe(true);
    expect(incomplete.content[0]?.text).toContain("missing: id");

    const nested = await executeApprovalRequestToolLocal(actor.claims, "approval_request", {
      toolName: "automation_delete",
      arguments: { id: "automation-1", approvalCapability: "model-invented" },
    });
    expect(nested.isError).toBe(true);
    expect(nested.content[0]?.text).toContain("Omit approvalCapability");

    expect(
      await db
        .select()
        .from(gatewayApprovalRequests)
        .where(eq(gatewayApprovalRequests.runId, actor.runId)),
    ).toHaveLength(0);
  });

  test("approval_poll reports pending, denial, and expiry", async () => {
    const actor = await runningActor();
    const { request } = await createApprovalRequest({
      orgId: actor.orgId,
      runId: actor.runId,
      threadId: actor.threadId,
      toolName: "automation_delete",
      arguments: { id: "automation-2" },
    });

    const pending = await executeApprovalRequestToolLocal(actor.claims, "approval_poll", {
      id: request.id,
    });
    expect(structured(pending)).toMatchObject({ status: "pending" });

    const denied = await denyApprovalRequest({
      orgId: actor.orgId,
      requestId: request.id,
      deniedBy: actor.userId,
    });
    expect(denied.ok).toBe(true);
    const afterDenial = await executeApprovalRequestToolLocal(actor.claims, "approval_poll", {
      id: request.id,
    });
    expect(structured(afterDenial)).toMatchObject({ status: "denied" });

    // A second, overdue request lapses lazily on the next read.
    const { request: overdue } = await createApprovalRequest({
      orgId: actor.orgId,
      runId: actor.runId,
      threadId: actor.threadId,
      toolName: "automation_delete",
      arguments: { id: "automation-3" },
    });
    await db
      .update(gatewayApprovalRequests)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(gatewayApprovalRequests.id, overdue.id));
    const lapsed = await executeApprovalRequestToolLocal(actor.claims, "approval_poll", {
      id: overdue.id,
    });
    expect(structured(lapsed)).toMatchObject({ status: "expired" });
    const stored = await getApprovalRequestForOrg(actor.orgId, overdue.id);
    expect(stored?.status).toBe("expired");
  });

  test("approve mints the real one-shot capability, poll hands it out exactly once, and it drives the gated operation", async () => {
    const actor = await runningActor();
    // Through the registry: proves the tools are registered in the live catalog.
    const requested = await executeRegisteredGatewayTool(actor.claims, "approval_request", {
      toolName: "automation_delete",
      arguments: { id: "automation-4" },
    });
    if (!requested.matched) throw new Error("approval_request is not registered");
    const requestId = structured(
      requested.result as { structuredContent?: Record<string, unknown> },
    ).approval_request_id as string;

    const approved = await approveApprovalRequest({
      orgId: actor.orgId,
      requestId,
      approvedBy: actor.userId,
    });
    expect(approved.ok).toBe(true);

    const resolvedEvents = await db
      .select()
      .from(providerEvents)
      .where(
        and(
          eq(providerEvents.runId, actor.runId),
          eq(providerEvents.eventType, "gateway.approval.resolved"),
        ),
      );
    expect(resolvedEvents).toHaveLength(1);
    // The capability must never ride the timeline event.
    expect(resolvedEvents[0]?.payload ?? "").not.toContain("capability");

    const delivered = await executeApprovalRequestToolLocal(actor.claims, "approval_poll", {
      id: requestId,
    });
    const payload = structured(delivered);
    expect(payload.status).toBe("approved");
    const capability = payload.approval_capability as string;
    expect(capability.length).toBeGreaterThan(0);
    const deliveryText = delivered.content.find((item) => item.type === "text")?.text ?? "";
    expect(deliveryText).toContain(`approvalCapability=${capability}`);

    // Handed out exactly once: the row's parked copy is cleared.
    const again = await executeApprovalRequestToolLocal(actor.claims, "approval_poll", {
      id: requestId,
    });
    expect(again.isError).toBe(true);
    expect(structured(again)).toMatchObject({ error: "capability_already_delivered" });

    // The delivered capability authorizes exactly the requested operation, once.
    expect(
      await consumeApprovalCapability({
        capability,
        claims: actor.claims,
        toolName: "automation_delete",
        arguments: { id: "automation-4" },
      }),
    ).toBe(true);
    expect(
      await consumeApprovalCapability({
        capability,
        claims: actor.claims,
        toolName: "automation_delete",
        arguments: { id: "automation-4" },
      }),
    ).toBe(false);
  });

  test("poll refuses to deliver another run's capability", async () => {
    const actor = await runningActor();
    const { request } = await createApprovalRequest({
      orgId: actor.orgId,
      runId: actor.runId,
      threadId: actor.threadId,
      toolName: "automation_delete",
      arguments: { id: "automation-5" },
    });
    await approveApprovalRequest({
      orgId: actor.orgId,
      requestId: request.id,
      approvedBy: actor.userId,
    });

    const otherRun = await runningActor({ orgId: actor.orgId, userId: actor.userId });
    const crossRun = await executeApprovalRequestToolLocal(otherRun.claims, "approval_poll", {
      id: request.id,
    });
    expect(crossRun.isError).toBe(true);
    expect(structured(crossRun)).toMatchObject({ error: "approval_request_run_mismatch" });

    // Still exactly one handout available to the requesting run.
    expect(
      await takeApprovalCapability({
        orgId: actor.orgId,
        runId: actor.runId,
        requestId: request.id,
      }),
    ).not.toBeNull();
  });

  test("resolution is race-safe: one approve wins, one capability handout wins", async () => {
    const actor = await runningActor();
    const { request } = await createApprovalRequest({
      orgId: actor.orgId,
      runId: actor.runId,
      threadId: actor.threadId,
      toolName: "automation_delete",
      arguments: { id: "automation-6" },
    });

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        approveApprovalRequest({
          orgId: actor.orgId,
          requestId: request.id,
          approvedBy: actor.userId,
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(
      outcomes
        .filter((outcome) => !outcome.ok)
        .every((outcome) => !outcome.ok && outcome.error === "request_not_pending"),
    ).toBe(true);

    const handouts = await Promise.all(
      Array.from({ length: 5 }, () =>
        takeApprovalCapability({
          orgId: actor.orgId,
          runId: actor.runId,
          requestId: request.id,
        }),
      ),
    );
    expect(handouts.filter((handout) => handout !== null)).toHaveLength(1);

    // A denial after the fact cannot flip the resolved request.
    const denyAfter = await denyApprovalRequest({
      orgId: actor.orgId,
      requestId: request.id,
      deniedBy: actor.userId,
    });
    expect(denyAfter).toEqual({ ok: false, error: "request_not_pending" });
  });

  test("the human API keeps the mint route's exact security shape", async () => {
    const { orgId: devOrgId, userId: devUserId } = getDevContext();

    // The session view lists pending requests for a run without the capability.
    const mine = await runningActor({ orgId: devOrgId, userId: devUserId });
    const { request } = await createApprovalRequest({
      orgId: mine.orgId,
      runId: mine.runId,
      threadId: mine.threadId,
      toolName: "automation_delete",
      arguments: { id: "automation-7" },
    });
    expect((await api("/api/gateway/approvals/requests")).status).toBe(400);
    const listed = await api(`/api/gateway/approvals/requests?runId=${mine.runId}`);
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { requests: Record<string, unknown>[] };
    expect(listBody.requests).toHaveLength(1);
    expect(listBody.requests[0]).toMatchObject({ id: request.id, status: "pending" });
    expect(Object.keys(listBody.requests[0] ?? {})).not.toContain("capability");

    // Approving another member's run is refused (member-403).
    const theirs = await runningActor({ orgId: devOrgId, userId: "someone-else" });
    const { request: theirRequest } = await createApprovalRequest({
      orgId: theirs.orgId,
      runId: theirs.runId,
      threadId: theirs.threadId,
      toolName: "automation_delete",
      arguments: { id: "automation-8" },
    });
    const forbidden = await api(
      `/api/gateway/approvals/requests/${theirRequest.id}/approve`,
      { method: "POST" },
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "run_user_mismatch" });

    // A settled run cannot be approved into.
    const settled = await runningActor({
      orgId: devOrgId,
      userId: devUserId,
      status: "completed",
    });
    const { request: settledRequest } = await createApprovalRequest({
      orgId: settled.orgId,
      runId: settled.runId,
      threadId: settled.threadId,
      toolName: "automation_delete",
      arguments: { id: "automation-9" },
    });
    const inactive = await api(
      `/api/gateway/approvals/requests/${settledRequest.id}/approve`,
      { method: "POST" },
    );
    expect(inactive.status).toBe(409);
    expect(await inactive.json()).toEqual({ error: "run_not_active" });

    // Another org's request id resolves as not-found, never cross-tenant.
    const foreign = await runningActor();
    const { request: foreignRequest } = await createApprovalRequest({
      orgId: foreign.orgId,
      runId: foreign.runId,
      threadId: foreign.threadId,
      toolName: "automation_delete",
      arguments: { id: "automation-10" },
    });
    const crossOrg = await api(
      `/api/gateway/approvals/requests/${foreignRequest.id}/approve`,
      { method: "POST" },
    );
    expect(crossOrg.status).toBe(404);
    expect(await crossOrg.json()).toEqual({ error: "request_not_found" });

    // The member's own active run approves, exactly once.
    const approve = await api(`/api/gateway/approvals/requests/${request.id}/approve`, {
      method: "POST",
    });
    expect(approve.status).toBe(200);
    expect(await approve.json()).toEqual({ id: request.id, status: "approved" });
    const denyResolved = await api(`/api/gateway/approvals/requests/${request.id}/deny`, {
      method: "POST",
    });
    expect(denyResolved.status).toBe(409);
    expect(await denyResolved.json()).toEqual({ error: "request_not_pending" });

    // And the approved capability flows only through the agent's poll.
    const polled = await executeApprovalRequestToolLocal(mine.claims, "approval_poll", {
      id: request.id,
    });
    expect(structured(polled)).toMatchObject({ status: "approved" });
  });

  test("summaries expose resolution metadata but never the parked capability", async () => {
    const actor = await runningActor();
    const { request } = await createApprovalRequest({
      orgId: actor.orgId,
      runId: actor.runId,
      threadId: actor.threadId,
      toolName: "automation_delete",
      arguments: { id: "automation-11" },
    });
    const approved = await approveApprovalRequest({
      orgId: actor.orgId,
      requestId: request.id,
      approvedBy: actor.userId,
    });
    if (!approved.ok) throw new Error("expected approval to succeed");
    const summary = approvalRequestSummary(approved.request);
    expect(summary).toMatchObject({
      id: request.id,
      status: "approved",
      resolved_by: actor.userId,
      tool_name: "automation_delete",
    });
    expect(Object.keys(summary)).not.toContain("capability");
  });
});
