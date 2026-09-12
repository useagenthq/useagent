import { and, asc, eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { childThreadBatchItems, childThreadBatches, type EngineId } from "../db/schema";
import { insertCommandWithRun } from "../commands/repo";
import { runIntentFingerprint } from "../commands/fingerprint";
import type { RunCommandInput, RunCommandIntent } from "../commands/types";
import { assertRunAdmissionOpen } from "../commands/admission";
import { getRunForOrg } from "./repo";
import { ensureEligiblePublicRootThreadRelationship, getThreadRelationship } from "./thread-relationship-repo";
import { isInternalRunOrigin } from "./origin";
import { isModelAllowedForEngine } from "./model-policy";
import { engineModelReadyForDispatch } from "./engine-readiness";
import { boundedChildTitle, CHILD_BATCH_LIMIT, CHILD_PROMPT_MAX_CHARS } from "./child-session-policy";
import { publishRunLifecycleChange, publishThreadRelationshipChange } from "./org-signals";
import { pumpProductChildThread } from "./child-session-pump";
import { kickSlackOutbox } from "../slack/outbox";
import { legacyParentResources, resolveRunIntake } from "../resources/run-intake";
import { createRunResourceAuthorization } from "../resources/authorization";

export interface ProductChildInput {
  readonly title: string;
  readonly prompt: string;
  readonly engine?: EngineId | null;
  readonly model?: string | null;
}

export interface AcceptedProductChild {
  readonly ordinal: number;
  readonly threadId: string;
  readonly runId: string;
  readonly title: string;
  readonly engine: EngineId;
  readonly model: string;
}

export type ProductChildBatchOutcome =
  | { readonly status: "created" | "replayed"; readonly batchId: string; readonly children: readonly AcceptedProductChild[] }
  | { readonly status: "conflict" };

function digest(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}

async function lockParent(exec: Executor, orgId: string, parentThreadId: string): Promise<void> {
  await exec.execute(sql`select pg_advisory_xact_lock(hashtext(${orgId}), hashtext(${parentThreadId}))`);
}

async function readBatch(
  orgId: string,
  parentThreadId: string,
  idempotencyKey: string,
  exec: Executor,
) {
  const [batch] = await exec.select().from(childThreadBatches).where(and(
    eq(childThreadBatches.orgId, orgId),
    eq(childThreadBatches.parentThreadId, parentThreadId),
    eq(childThreadBatches.idempotencyKey, idempotencyKey),
  )).limit(1);
  if (!batch) return null;
  const items = await exec.select().from(childThreadBatchItems).where(
    eq(childThreadBatchItems.batchId, batch.id),
  ).orderBy(asc(childThreadBatchItems.ordinal));
  return { batch, items };
}

export async function acceptProductChildBatch(input: {
  readonly orgId: string;
  readonly actorId: string | null;
  readonly parentRunId: string;
  readonly parentThreadId: string;
  readonly idempotencyKey: string;
  readonly children: readonly ProductChildInput[];
}): Promise<ProductChildBatchOutcome> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 240) {
    throw new Error("invalid child batch idempotency key");
  }
  if (input.children.length < 1 || input.children.length > CHILD_BATCH_LIMIT) {
    throw new Error(`child batch size must be 1 to ${CHILD_BATCH_LIMIT}`);
  }
  const parent = await getRunForOrg(input.orgId, input.parentRunId);
  if (!parent || parent.threadId !== input.parentThreadId) throw new Error("child batch parent unavailable");
  await ensureEligiblePublicRootThreadRelationship({ orgId: input.orgId, threadId: input.parentThreadId });
  const relationship = await getThreadRelationship(input.orgId, input.parentThreadId);
  if (!relationship) throw new Error("child batch parent relationship unavailable");
  const inheritedResources = parent.resolvedResources.length > 0
    ? parent.resolvedResources
    : legacyParentResources(parent.repos, "api");

  const normalized = input.children.map((child) => {
    const title = boundedChildTitle(child.title);
    const prompt = child.prompt.trim();
    if (!prompt || prompt.length > CHILD_PROMPT_MAX_CHARS) throw new Error("invalid child prompt");
    const engine = child.engine ?? parent.engine;
    const model = child.model?.trim() || (engine === parent.engine ? parent.model : "");
    if (!model) throw new Error(`model is required when child engine differs from parent: ${engine}`);
    return { title, prompt, engine, model };
  });
  const authority = [
    input.orgId,
    input.parentThreadId,
    input.parentRunId,
    parent.projectId,
    parent.repos,
    inheritedResources,
    parent.memoryScope,
    parent.origin,
    input.actorId,
  ];
  const fingerprint = digest([normalized, digest(authority)]);

  const classifyReplay = (replay: NonNullable<Awaited<ReturnType<typeof readBatch>>>): ProductChildBatchOutcome => {
    if (
      replay.batch.parentRunId !== input.parentRunId ||
      replay.batch.familyThreadId !== relationship.familyThreadId ||
      replay.batch.actorId !== input.actorId ||
      replay.batch.itemCount !== normalized.length ||
      replay.batch.requestFingerprint !== fingerprint
    ) return { status: "conflict" };
    return {
      status: "replayed",
      batchId: replay.batch.id,
      children: replay.items.map((item, ordinal) => ({
        ordinal,
        threadId: item.childThreadId,
        runId: item.childRunId,
        ...normalized[ordinal]!,
      })),
    };
  };
  const preflight = await db.transaction(async (tx) => {
    await lockParent(tx, input.orgId, input.parentThreadId);
    return readBatch(input.orgId, input.parentThreadId, idempotencyKey, tx);
  });
  if (preflight) return classifyReplay(preflight);

  for (const child of normalized) {
    if (!isModelAllowedForEngine(child.engine, child.model) || !engineModelReadyForDispatch(child.engine, child.model)) {
      throw new Error(`engine/model not ready: ${child.engine}/${child.model}`);
    }
  }
  const intake = await resolveRunIntake(
    { source: "api", text: "", inheritedResources },
    { authorize: createRunResourceAuthorization(input.orgId) },
  );

  const result = await db.transaction(async (tx) => {
    await lockParent(tx, input.orgId, input.parentThreadId);
    const replay = await readBatch(input.orgId, input.parentThreadId, idempotencyKey, tx);
    if (replay) return classifyReplay(replay);
    await assertRunAdmissionOpen(tx);
    const batchId = crypto.randomUUID();
    await tx.insert(childThreadBatches).values({
      id: batchId,
      orgId: input.orgId,
      parentThreadId: input.parentThreadId,
      parentRunId: input.parentRunId,
      familyThreadId: relationship.familyThreadId,
      actorId: input.actorId,
      idempotencyKey,
      requestFingerprint: fingerprint,
      itemCount: normalized.length,
    });
    const children: AcceptedProductChild[] = [];
    for (const [ordinal, child] of normalized.entries()) {
      const runId = crypto.randomUUID();
      const intent: RunCommandIntent = {
        prompt: child.prompt,
        model: child.model,
        engine: child.engine,
        parentRunId: null,
        requestedRepos: [],
        requestedResources: [],
        attachmentIds: [],
        memoryScope: parent.memoryScope,
        skillId: null,
        skillVersion: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      };
      const run: RunCommandInput["run"] = {
        id: runId,
        prompt: child.prompt,
        model: child.model,
        engine: child.engine,
        parentRunId: null,
        threadId: runId,
        repos: [...intake.repos],
        resolvedResources: intake.resources,
        attachmentIds: [],
        memoryScope: parent.memoryScope,
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      };
      await insertCommandWithRun({
        commandId: crypto.randomUUID(),
        idempotencyKey: null,
        orgId: input.orgId,
        actorId: input.actorId,
        payloadFingerprint: runIntentFingerprint(intent),
        payload: JSON.stringify({ intent, threadId: runId }).slice(0, 8_192),
        run,
        origin: isInternalRunOrigin(parent.origin) ? parent.origin : null,
        priority: 0,
        threadRelationship: {
          parentThreadId: input.parentThreadId,
          familyThreadId: relationship.familyThreadId,
          kind: "delegated",
          title: child.title,
          sourceRunId: input.parentRunId,
          sourceExecutionId: null,
        },
      }, tx);
      await tx.insert(childThreadBatchItems).values({
        batchId,
        orgId: input.orgId,
        ordinal,
        childThreadId: runId,
        childRunId: runId,
      });
      children.push({ ordinal, threadId: runId, runId, ...child });
    }
    return { status: "created" as const, batchId, children };
  });
  if (result.status === "created") {
    kickSlackOutbox();
    for (const child of result.children) {
      publishThreadRelationshipChange({
        orgId: input.orgId,
        threadId: child.threadId,
        familyThreadId: relationship.familyThreadId,
      });
      if (!isInternalRunOrigin(parent.origin)) publishRunLifecycleChange({
        orgId: input.orgId,
        threadId: child.threadId,
        runId: child.runId,
        kind: "created",
      });
      await pumpProductChildThread(child.threadId).catch((error) => {
        console.error(`[child-session] batch pump failed for ${child.threadId}:`, error);
      });
    }
  }
  return result;
}
