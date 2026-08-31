import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  createArtifactRecord,
  getArtifactForOrg,
  reviseArtifactPublication,
  toArtifactDescriptor,
} from "../../artifacts/repo";
import { listFinishedWorkForRun } from "../../runs/finished-work-repo";
import { resetFinishedWorkSessionLockClientForTest } from "../../runs/finished-work-lock";
import { finalizeRun } from "../../runs/finalize";
import { createRun } from "../../runs/repo";
import { db } from "../../db/client";
import { providerEvents } from "../../db/schema";
import { setSandboxArtifactPublisherForTest } from "./artifact-tools";
import { handleMcpMessage } from "./mcp";
import {
  advertisedGatewayToolDescriptor,
  executeRegisteredGatewayTool,
  gatewayToolListDescriptors,
  setGatewayCompletionEventRecorderForTest,
} from "./operation-registry";
import type { ToolTokenClaims } from "./token";
import "../../../test/helpers";

const ORG = "org-skynet-dev";
const previousRollout = process.env.FINISHED_WORK_ROLLOUT;
const previousEnforceEngines = process.env.FINISHED_WORK_ENFORCE_ENGINES;
const previousEnforceRuns = process.env.FINISHED_WORK_ENFORCE_RUN_IDS;

async function actor(): Promise<{ claims: ToolTokenClaims; runId: string }> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "produce a finished artifact",
    model: "test",
    engine: "mock",
    orgId: ORG,
    userId: null,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  return {
    runId,
    claims: {
      orgId: ORG,
      userId: "",
      threadId: runId,
      runId,
      scope: "run",
      exp: Date.now() + 60_000,
    },
  };
}

function resultRecord(value: unknown): {
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
} {
  if (!value || typeof value !== "object") throw new Error("expected gateway tool result");
  return value;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

beforeEach(() => {
  process.env.FINISHED_WORK_ROLLOUT = "shadow";
});

afterEach(async () => {
  setSandboxArtifactPublisherForTest(null);
  setGatewayCompletionEventRecorderForTest(null);
  if (previousRollout === undefined) delete process.env.FINISHED_WORK_ROLLOUT;
  else process.env.FINISHED_WORK_ROLLOUT = previousRollout;
  if (previousEnforceEngines === undefined) delete process.env.FINISHED_WORK_ENFORCE_ENGINES;
  else process.env.FINISHED_WORK_ENFORCE_ENGINES = previousEnforceEngines;
  if (previousEnforceRuns === undefined) delete process.env.FINISHED_WORK_ENFORCE_RUN_IDS;
  else process.env.FINISHED_WORK_ENFORCE_RUN_IDS = previousEnforceRuns;
  await resetFinishedWorkSessionLockClientForTest();
});

describe("gateway FinishedWork producers", () => {
  test("keeps completion effects trusted while leaving read-only and proposal descriptors unchanged", () => {
    expect(advertisedGatewayToolDescriptor("artifact_publish")?.completionEffect).toEqual({
      kind: "artifact_publish",
      authority: "artifact_store",
      updateTargetArgument: "updates_artifact_id",
    });
    expect(advertisedGatewayToolDescriptor("workpiece_create")?.completionEffect).toEqual({
      kind: "artifact_create",
      authority: "workpiece_store",
    });
    expect(advertisedGatewayToolDescriptor("workpiece_update")?.completionEffect).toEqual({
      kind: "artifact_update",
      authority: "workpiece_store",
      targetArtifactArgument: "artifact_id",
    });
    expect(advertisedGatewayToolDescriptor("workpiece_propose_edit")?.completionEffect).toBeUndefined();
    expect(advertisedGatewayToolDescriptor("knowledge_search")?.completionEffect).toBeUndefined();
    expect(
      gatewayToolListDescriptors({ childSessions: true, slack: true }).some(
        (tool) => Object.hasOwn(tool, "completionEffect"),
      ),
    ).toBe(false);
  });

  test("records exact create/update receipts and leaves proposals non-completing", async () => {
    const { claims, runId } = await actor();
    const created = await executeRegisteredGatewayTool(
      claims,
      "workpiece_create",
      { kind: "document", name: "Plan.docx", state: { text: "first" } },
      undefined,
      { requestId: "create-1" },
    );
    expect(created.matched).toBe(true);
    if (!created.matched) throw new Error("workpiece_create missing");
    const createdResult = resultRecord(created.result);
    expect(createdResult.isError).not.toBe(true);
    expect(createdResult.structuredContent?.finished_work_receipt).toMatchObject({
      kind: "artifact_created",
      authority: "workpiece_store",
      artifact_revision: 0,
    });
    const artifact = createdResult.structuredContent?.artifact as { readonly id: string };

    const proposal = await executeRegisteredGatewayTool(
      claims,
      "workpiece_propose_edit",
      { artifact_id: artifact.id, state: { text: "suggested" } },
      undefined,
      { requestId: "proposal-1" },
    );
    expect(proposal.matched).toBe(true);
    if (!proposal.matched) throw new Error("workpiece_propose_edit missing");
    expect(resultRecord(proposal.result).structuredContent?.finished_work_receipt).toBeUndefined();
    expect((await listFinishedWorkForRun(ORG, runId)).obligations).toHaveLength(1);

    const updated = await executeRegisteredGatewayTool(
      claims,
      "workpiece_update",
      { artifact_id: artifact.id, state: { text: "final" } },
      undefined,
      { requestId: "update-1" },
    );
    expect(updated.matched).toBe(true);
    if (!updated.matched) throw new Error("workpiece_update missing");
    expect(resultRecord(updated.result).structuredContent?.finished_work_receipt).toMatchObject({
      kind: "artifact_updated",
      authority: "workpiece_store",
      artifact_id: artifact.id,
      artifact_revision: 1,
    });
    const [revisionEvent] = await db
      .select({ eventType: providerEvents.eventType })
      .from(providerEvents)
      .where(
        and(
          eq(providerEvents.runId, runId),
          eq(providerEvents.eventType, "artifact.revised"),
        ),
      )
      .limit(1);
    expect(revisionEvent).toEqual({ eventType: "artifact.revised" });

    const state = await listFinishedWorkForRun(ORG, runId);
    expect(state.obligations.map((item) => item.state)).toEqual(["satisfied", "satisfied"]);
    expect(state.receipts.map((item) => item.kind).toSorted()).toEqual([
      "artifact_created",
      "artifact_updated",
    ]);
  });

  test("waives validation errors and lets the same request identity converge on retry", async () => {
    const { claims, runId } = await actor();
    const failed = await executeRegisteredGatewayTool(
      claims,
      "workpiece_create",
      { kind: "document", name: "Retry.docx", state: { invalid: true } },
      undefined,
      { requestId: 41 },
    );
    expect(failed.matched).toBe(true);
    if (!failed.matched) throw new Error("workpiece_create missing");
    expect(resultRecord(failed.result).isError).toBe(true);
    expect((await listFinishedWorkForRun(ORG, runId)).obligations[0]?.state).toBe("waived");

    const retried = await executeRegisteredGatewayTool(
      claims,
      "workpiece_create",
      { kind: "document", name: "Retry.docx", state: { text: "valid" } },
      undefined,
      { requestId: 41 },
    );
    expect(retried.matched).toBe(true);
    if (!retried.matched) throw new Error("workpiece_create missing");
    expect(resultRecord(retried.result).structuredContent?.finished_work_receipt).toMatchObject({
      kind: "artifact_created",
    });
    expect((await listFinishedWorkForRun(ORG, runId)).obligations.map((item) => item.state).toSorted())
      .toEqual(["satisfied", "waived"]);
  });

  test("replays duplicate request identities without invoking the mutation twice", async () => {
    const { claims, runId } = await actor();
    const args = { kind: "document", name: "Once.docx", state: { text: "one" } };
    const request = {
      jsonrpc: "2.0" as const,
      id: "same-call",
      method: "tools/call",
      params: { name: "workpiece_create", arguments: args },
    };
    const firstResponse = await handleMcpMessage(
      claims,
      request,
    );
    const secondResponse = await handleMcpMessage(
      claims,
      request,
    );
    if (!firstResponse?.result || !secondResponse?.result) throw new Error("MCP result missing");
    const firstReceipt = resultRecord(firstResponse.result).structuredContent?.finished_work_receipt;
    const secondReceipt = resultRecord(secondResponse.result).structuredContent?.finished_work_receipt;
    expect(secondReceipt).toEqual(firstReceipt);
    const state = await listFinishedWorkForRun(ORG, runId);
    expect(state.obligations).toHaveLength(1);
    expect(state.receipts).toHaveLength(1);
  });

  test("serializes concurrent duplicate request identities across the full mutation", async () => {
    const { claims, runId } = await actor();
    let mutations = 0;
    setSandboxArtifactPublisherForTest(async (input) => {
      mutations += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const stored = await createArtifactRecord({
        orgId: input.orgId,
        userId: input.userId,
        runId: input.runId,
        threadId: input.threadId ?? input.runId,
        sourcePath: input.path,
        name: "concurrent.pdf",
        contentType: "application/pdf",
        sizeBytes: 4,
        sha256: sha("same"),
        storageKey: `test/${input.runId}/concurrent`,
      });
      return { artifact: toArtifactDescriptor(stored.row), created: stored.created };
    });
    const invoke = () => handleMcpMessage(claims, {
      jsonrpc: "2.0",
      id: "concurrent-call",
      method: "tools/call",
      params: { name: "artifact_publish", arguments: { path: "/root/work/concurrent.pdf" } },
    });
    const [first, second] = await Promise.all([invoke(), invoke()]);
    expect(first?.result && second?.result).toBeTruthy();
    expect(mutations).toBe(1);
    const state = await listFinishedWorkForRun(ORG, runId);
    expect(state.obligations).toHaveLength(1);
    expect(state.obligations[0]).toMatchObject({ state: "satisfied" });
    expect(state.receipts).toHaveLength(1);
    const events = await db
      .select({ id: providerEvents.id })
      .from(providerEvents)
      .where(
        and(
          eq(providerEvents.runId, runId),
          eq(providerEvents.eventType, "artifact.created"),
        ),
      );
    expect(events).toHaveLength(1);
  });

  test("bounds 12 distinct completion callbacks that open main-pool transactions", async () => {
    const { claims, runId } = await actor();
    const executions = Array.from({ length: 12 }, (_, index) =>
      executeRegisteredGatewayTool(
        claims,
        "workpiece_create",
        { kind: "document", name: `Concurrent-${index}.docx`, state: { text: `${index}` } },
        undefined,
        { requestId: `distinct-call-${index}` },
      ));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const results = await Promise.race([
      Promise.all(executions),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("gateway completion calls exhausted the database pool")), 5_000);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });

    expect(results).toHaveLength(12);
    expect(results.every((result) => result.matched && !resultRecord(result.result).isError)).toBe(true);
    const state = await listFinishedWorkForRun(ORG, runId);
    expect(state.obligations).toHaveLength(12);
    expect(state.receipts).toHaveLength(12);
  });

  test("rollout off preserves the legacy result and creates no completion state", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "off";
    setGatewayCompletionEventRecorderForTest(async () => {
      throw new Error("enabled-only required event failure");
    });
    const { claims, runId } = await actor();
    const execution = await executeRegisteredGatewayTool(
      claims,
      "workpiece_create",
      { kind: "document", name: "Legacy.docx", state: { text: "legacy" } },
      undefined,
      { requestId: "off-call" },
    );
    if (!execution.matched) throw new Error("workpiece_create missing");
    expect(resultRecord(execution.result).isError).not.toBe(true);
    expect(resultRecord(execution.result).structuredContent?.finished_work_receipt).toBeUndefined();
    expect(await listFinishedWorkForRun(ORG, runId)).toEqual({ obligations: [], receipts: [] });
  });

  test("rollout enforce enables the same completion producer path as shadow", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "enforce";
    const { claims, runId } = await actor();
    const execution = await executeRegisteredGatewayTool(
      claims,
      "workpiece_create",
      { kind: "document", name: "Enforced.docx", state: { text: "enforced" } },
      undefined,
      { requestId: "enforced-call" },
    );
    if (!execution.matched) throw new Error("workpiece_create missing");
    expect(resultRecord(execution.result).structuredContent?.finished_work_receipt).toMatchObject({
      kind: "artifact_created",
      authority: "workpiece_store",
    });
    expect((await listFinishedWorkForRun(ORG, runId)).obligations[0]?.state).toBe("satisfied");
  });

  test("holds the run lock through mutation and receipt so enforce finalization waits", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "enforce";
    delete process.env.FINISHED_WORK_ENFORCE_ENGINES;
    delete process.env.FINISHED_WORK_ENFORCE_RUN_IDS;
    const { claims, runId } = await actor();
    let reportStarted!: () => void;
    let releaseMutation!: () => void;
    const started = new Promise<void>((resolve) => { reportStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
    setSandboxArtifactPublisherForTest(async (input) => {
      reportStarted();
      await release;
      const stored = await createArtifactRecord({
        orgId: input.orgId,
        userId: input.userId,
        runId: input.runId,
        threadId: input.threadId ?? input.runId,
        sourcePath: input.path,
        name: "finalizer-race.pdf",
        contentType: "application/pdf",
        sizeBytes: 4,
        sha256: sha("race"),
        storageKey: `test/${input.runId}/finalizer-race`,
      });
      return { artifact: toArtifactDescriptor(stored.row), created: stored.created };
    });
    const execution = executeRegisteredGatewayTool(
      claims,
      "artifact_publish",
      { path: "/root/work/finalizer-race.pdf" },
      undefined,
      { requestId: "finalizer-race" },
    );
    await started;
    const finalization = finalizeRun(runId, "completed", "published", 10);
    releaseMutation();
    const [toolResult, finalResult] = await Promise.all([execution, finalization]);
    expect(toolResult.matched).toBe(true);
    expect(finalResult).toEqual({ applied: true, status: "completed", summary: "published" });
    expect((await listFinishedWorkForRun(ORG, runId)).receipts).toHaveLength(1);
  });

  test("reconciles a committed workpiece mutation after a required event failure", async () => {
    const { claims, runId } = await actor();
    const created = await executeRegisteredGatewayTool(
      claims,
      "workpiece_create",
      { kind: "document", name: "Reconcile.docx", state: { text: "before" } },
      undefined,
      { requestId: "reconcile-create" },
    );
    if (!created.matched) throw new Error("workpiece_create missing");
    const artifact = resultRecord(created.result).structuredContent?.artifact as {
      readonly id: string;
    };

    let eventAttempts = 0;
    setGatewayCompletionEventRecorderForTest(async () => {
      eventAttempts += 1;
      if (eventAttempts === 1) throw new Error("transient event failure");
    });
    const args = { artifact_id: artifact.id, state: { text: "after" } };
    const first = await executeRegisteredGatewayTool(
      claims,
      "workpiece_update",
      args,
      undefined,
      { requestId: "reconcile-update" },
    );
    if (!first.matched) throw new Error("workpiece_update missing");
    expect(resultRecord(first.result)).toMatchObject({ isError: true });
    let state = await listFinishedWorkForRun(ORG, runId);
    const updateObligation = state.obligations.find((item) => item.requirement === "artifact_update");
    expect(updateObligation).toMatchObject({
      state: "open",
      targetArtifactId: artifact.id,
      materializedArtifactId: artifact.id,
      materializedArtifactRevision: 1,
    });
    expect(state.receipts.filter((item) => item.kind === "artifact_updated")).toHaveLength(0);

    const retried = await executeRegisteredGatewayTool(
      claims,
      "workpiece_update",
      args,
      undefined,
      { requestId: "reconcile-update" },
    );
    if (!retried.matched) throw new Error("workpiece_update missing");
    expect(resultRecord(retried.result).structuredContent?.finished_work_receipt).toMatchObject({
      kind: "artifact_updated",
      artifact_id: artifact.id,
      artifact_revision: 1,
    });
    state = await listFinishedWorkForRun(ORG, runId);
    expect(state.obligations.find((item) => item.id === updateObligation?.id)?.state).toBe("satisfied");
    expect((await getArtifactForOrg(ORG, artifact.id))?.workpieceRevision).toBe(1);
    expect(eventAttempts).toBe(2);
  });

  test("resolves artifact_publish create vs update from updates_artifact_id", async () => {
    const { claims, runId } = await actor();
    setSandboxArtifactPublisherForTest(async (input) => {
      const sourcePath = input.path;
      if (input.updatesArtifactId) {
        const revised = await reviseArtifactPublication({
          orgId: input.orgId,
          id: input.updatesArtifactId,
          name: "report-v2.pdf",
          contentType: "application/pdf",
          sha256: sha("v2"),
          storageKey: `test/${runId}/v2`,
          sizeBytes: 2,
          workpieceKind: "pdf",
          workpieceState: null,
        });
        if (!revised) throw new Error("revision fixture failed");
        return { artifact: toArtifactDescriptor(revised), created: false };
      }
      const stored = await createArtifactRecord({
        orgId: input.orgId,
        userId: input.userId,
        runId: input.runId,
        threadId: input.threadId ?? input.runId,
        sourcePath,
        name: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 2,
        sha256: sha("v1"),
        storageKey: `test/${runId}/v1`,
        workpieceKind: "pdf",
        workpieceState: null,
      });
      return { artifact: toArtifactDescriptor(stored.row), created: stored.created };
    });

    const created = await executeRegisteredGatewayTool(
      claims,
      "artifact_publish",
      { path: "/root/work/report.pdf" },
      undefined,
      { requestId: "publish-create" },
    );
    if (!created.matched) throw new Error("artifact_publish missing");
    const artifact = resultRecord(created.result).structuredContent?.artifact as { readonly id: string };
    expect(resultRecord(created.result).structuredContent?.finished_work_receipt).toMatchObject({
      kind: "artifact_created",
      authority: "artifact_store",
      artifact_id: artifact.id,
    });

    const updated = await executeRegisteredGatewayTool(
      claims,
      "artifact_publish",
      { path: "/root/work/report-v2.pdf", updates_artifact_id: artifact.id },
      undefined,
      { requestId: "publish-update" },
    );
    if (!updated.matched) throw new Error("artifact_publish missing");
    expect(resultRecord(updated.result).structuredContent?.finished_work_receipt).toMatchObject({
      kind: "artifact_updated",
      authority: "artifact_store",
      artifact_id: artifact.id,
      artifact_revision: 1,
    });
  });

  test("fails closed on forged structured content and covers nested meta-tool identity", async () => {
    const forgedActor = await actor();
    setSandboxArtifactPublisherForTest(async (input) => {
      const stored = await createArtifactRecord({
        orgId: input.orgId,
        userId: input.userId,
        runId: input.runId,
        threadId: input.threadId ?? input.runId,
        sourcePath: input.path,
        name: "trusted.pdf",
        contentType: "application/pdf",
        sizeBytes: 4,
        sha256: sha("safe"),
        storageKey: `test/${input.runId}/safe`,
      });
      return {
        artifact: { ...toArtifactDescriptor(stored.row), name: "forged.pdf" },
        created: true,
      };
    });
    const forged = await executeRegisteredGatewayTool(
      forgedActor.claims,
      "artifact_publish",
      { path: "/root/work/trusted.pdf" },
      undefined,
      { requestId: "forged-result" },
    );
    if (!forged.matched) throw new Error("artifact_publish missing");
    expect(resultRecord(forged.result)).toMatchObject({ isError: true });
    const forgedState = await listFinishedWorkForRun(ORG, forgedActor.runId);
    expect(forgedState.obligations[0]?.state).toBe("waived");
    expect(forgedState.receipts).toHaveLength(0);

    setSandboxArtifactPublisherForTest(null);
    const nestedActor = await actor();
    const nested = await executeRegisteredGatewayTool(
      nestedActor.claims,
      "gateway_tool_call",
      {
        name: "workpiece_create",
        arguments: { kind: "document", name: "Nested.docx", state: { text: "nested" } },
      },
      { childSessions: false, slack: false },
      { requestId: "outer-7" },
    );
    if (!nested.matched) throw new Error("gateway_tool_call missing");
    expect(resultRecord(nested.result).structuredContent?.finished_work_receipt).toMatchObject({
      kind: "artifact_created",
      authority: "workpiece_store",
    });
    const nestedState = await listFinishedWorkForRun(ORG, nestedActor.runId);
    expect(nestedState.obligations).toHaveLength(1);
    expect(nestedState.obligations[0]?.sourceCallId).toMatch(/^rpc:[0-9a-f]{64}$/);
  });
});
