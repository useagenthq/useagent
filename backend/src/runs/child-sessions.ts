import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import { commands, providerEvents, runs, type EngineId, type MemoryScope, type RunStatus } from "../db/schema";
import { db } from "../db/client";
import {
  acceptInternalRunCommand,
  acceptRunCommand,
  preflightInternalRunCommandReplay,
  preflightRunCommandReplay,
} from "../commands/service";
import type { RunCommandIntent } from "../commands/types";
import { countNativeFrames, getNativeFramesSince, type NativeFrame } from "./native-events";
import { CHILD_SESSION_IDEMPOTENCY_PREFIX, getRunForOrg } from "./repo";
import { createRunResourceAuthorization } from "../resources/authorization";
import {
  legacyParentResources,
  resolveRunIntake,
} from "../resources/run-intake";
import { isInternalRunOrigin } from "./origin";
import {
  ensureEligiblePublicRootThreadRelationship,
  getThreadRelationship,
  getThreadRelationshipView,
  listDirectThreadChildren,
} from "./thread-relationship-repo";
import { productChildThreadsEnabled } from "./thread-relationship-rollout";
import { boundedChildTitle } from "./child-session-policy";
import { pumpProductChildThread } from "./child-session-pump";
import type { ProductThreadStatus } from "./thread-status";
import { kickSlackOutbox } from "../slack/outbox";
import { listArtifactsForOrg } from "../artifacts/repo";
import { listFinishedWorkForRun } from "./finished-work-repo";
import { CHILD_REFERENCE_PAGE_LIMIT, CHILD_RESULT_MAX_CHARS } from "./child-session-policy";
import { publishThreadRelationshipChange } from "./org-signals";

// The namespace lives in repo.ts (the projection also reads it to mark
// `child_session` on the wire); re-exported here for existing importers.
export { CHILD_SESSION_IDEMPOTENCY_PREFIX };

const MAX_CHILD_LIMIT = 20;
const MAX_EVENT_LIMIT = 50;

export interface ChildSessionSummary {
  readonly id: string;
  readonly kind: "product_thread" | "legacy_child_run";
  readonly messageable: boolean;
  readonly parentRunId: string | null;
  readonly threadId: string;
  readonly status: RunStatus | ProductThreadStatus;
  readonly promptPreview: string;
  readonly engine: EngineId;
  readonly model: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly eventRef: string;
}

export interface ChildSessionEventPage {
  readonly childRunId: string;
  readonly cursorRunId: string;
  readonly events: readonly NativeFrame[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
  readonly eventCount: number;
  readonly eventRef: string;
}

function childKeyPrefix(threadId: string): string {
  return `${CHILD_SESSION_IDEMPOTENCY_PREFIX}:${threadId}:`;
}

function childKey(threadId: string, parentRunId: string, idempotencyKey: string): string {
  return `${childKeyPrefix(threadId)}${parentRunId}:${idempotencyKey}`;
}

function boundedLimit(value: unknown, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(1, value));
}

function preview(text: string): string {
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function toSummary(row: {
  readonly id: string;
  readonly parentRunId: string | null;
  readonly threadId: string;
  readonly status: RunStatus;
  readonly prompt: string;
  readonly engine: EngineId;
  readonly model: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): ChildSessionSummary {
  return {
    id: row.id,
    kind: "legacy_child_run",
    messageable: false,
    parentRunId: row.parentRunId,
    threadId: row.threadId,
    status: row.status,
    promptPreview: preview(row.prompt),
    engine: row.engine,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    eventRef: `skynet://runs/${row.id}/native-events`,
  };
}

export function childSessionLimit(value: unknown, fallback = 10): number {
  return boundedLimit(value, MAX_CHILD_LIMIT, fallback);
}

export function childSessionEventLimit(value: unknown, fallback = 25): number {
  return boundedLimit(value, MAX_EVENT_LIMIT, fallback);
}

/** The command key a product child is created under; a retry with the same caller key must find it. */
export function productChildCommandKey(threadId: string, parentRunId: string, idempotencyKey: string): string {
  return `product-child:${threadId}:${parentRunId}:${idempotencyKey}`;
}

export async function createChildSession(input: {
  readonly orgId: string;
  readonly actorId: string | null;
  readonly parentRunId: string;
  readonly threadId: string;
  readonly prompt: string;
  readonly title?: string;
  readonly relationshipKind?: "delegated" | "continued_from_native";
  readonly sourceExecutionId?: string | null;
  readonly engine: EngineId;
  readonly model: string;
  readonly repos: readonly string[];
  readonly memoryScope: MemoryScope;
  readonly idempotencyKey: string;
}): Promise<{ readonly status: "created" | "replayed"; readonly child: ChildSessionSummary } | { readonly status: "conflict" }> {
  const runId = crypto.randomUUID();
  const productChild = productChildThreadsEnabled(input.orgId);
  const idempotencyKey = productChild
    ? productChildCommandKey(input.threadId, input.parentRunId, input.idempotencyKey)
    : childKey(
    input.threadId,
    input.parentRunId,
    input.idempotencyKey,
  );
  const childThreadId = productChild ? runId : input.threadId;
  const intent: RunCommandIntent = {
    prompt: input.prompt,
    model: input.model,
    engine: input.engine,
    parentRunId: productChild ? null : input.parentRunId,
    // Child sessions inherit the parent's already-authorized resources. They
    // cannot make an explicit repository selection of their own.
    requestedRepos: [],
    requestedResources: [],
    attachmentIds: [],
    memoryScope: input.memoryScope,
    skillId: null,
    skillVersion: null,
    commandName: null,
    commandProvider: null,
    commandSessionId: null,
    commandCatalogRevision: null,
  };
  const parent = await getRunForOrg(input.orgId, input.parentRunId);
  if (!parent || parent.threadId !== input.threadId) {
    throw new Error("child session parent is not available in this thread");
  }
  const internalOrigin = isInternalRunOrigin(parent.origin) ? parent.origin : null;
  if (productChild) {
    await ensureEligiblePublicRootThreadRelationship({ orgId: input.orgId, threadId: input.threadId });
  }
  const parentRelationship = productChild
    ? await getThreadRelationship(input.orgId, input.threadId)
    : null;
  if (productChild && !parentRelationship) {
    throw new Error("product child parent relationship is unavailable");
  }
  const productRelationship = productChild ? {
    parentThreadId: input.threadId,
    familyThreadId: parentRelationship!.familyThreadId,
    kind: input.relationshipKind ?? "delegated" as const,
    title: boundedChildTitle((input.title ?? input.prompt).slice(0, 160)),
    sourceRunId: input.parentRunId,
    sourceExecutionId: input.sourceExecutionId ?? null,
  } : undefined;
  let accepted = productChild
    ? internalOrigin
      ? await preflightInternalRunCommandReplay({
          orgId: input.orgId,
          idempotencyKey,
          intent,
          origin: internalOrigin,
          threadRelationship: productRelationship,
        })
      : await preflightRunCommandReplay({
          orgId: input.orgId,
          idempotencyKey,
          intent,
          threadRelationship: productRelationship,
        })
    : internalOrigin
    ? await preflightInternalRunCommandReplay({
      orgId: input.orgId,
      idempotencyKey,
      intent,
      origin: internalOrigin,
    })
    : await preflightRunCommandReplay({
      orgId: input.orgId,
      idempotencyKey,
      intent,
    });
  if (accepted?.status === "conflict") return { status: "conflict" };

  if (!accepted) {
    const inheritedResources =
      parent.resolvedResources.length > 0
        ? parent.resolvedResources
        : legacyParentResources(parent.repos, "api");
    const intake = await resolveRunIntake(
      {
        source: "api",
        // Child prompts are agent-authored delegation text, not direct user
        // input, so they cannot discover or widen resource scope.
        text: "",
        inheritedResources,
      },
      { authorize: createRunResourceAuthorization(input.orgId) },
    );
    const commandInput = {
      idempotencyKey,
      orgId: input.orgId,
      actorId: input.actorId,
      intent,
      run: {
        id: runId,
        prompt: input.prompt,
        model: input.model,
        engine: input.engine,
        parentRunId: productChild ? null : input.parentRunId,
        threadId: childThreadId,
        repos: [...intake.repos],
        resolvedResources: intake.resources,
        attachmentIds: [],
        memoryScope: input.memoryScope,
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
      ...(productRelationship ? { threadRelationship: productRelationship } : {}),
    };
    accepted = internalOrigin
      ? await acceptInternalRunCommand({ ...commandInput, origin: internalOrigin })
      : await acceptRunCommand(commandInput);
  }
  if (accepted.status === "conflict") return { status: "conflict" };
  if (productChild && accepted.status === "created") {
    publishThreadRelationshipChange({
      orgId: input.orgId,
      threadId: childThreadId,
      familyThreadId: parentRelationship!.familyThreadId,
    });
    kickSlackOutbox();
    await pumpProductChildThread(childThreadId).catch((error) => {
      console.error(`[child-session] immediate pump failed for ${childThreadId}:`, error);
    });
  }
  const child = productChild
    ? await getProductChildSession(input.orgId, accepted.runId)
    : await getChildSession(input.orgId, input.threadId, accepted.runId);
  if (!child) throw new Error(`Accepted child session ${accepted.runId} was not readable`);
  return { status: accepted.status, child };
}

async function getProductChildSession(orgId: string, childThreadId: string): Promise<ChildSessionSummary | null> {
  const view = await getThreadRelationshipView(orgId, childThreadId);
  if (!view) return null;
  return {
    id: view.threadId,
    kind: "product_thread",
    messageable: true,
    parentRunId: view.sourceRunId,
    threadId: view.threadId,
    status: view.status,
    promptPreview: view.title,
    engine: view.engine,
    model: view.model,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.latestActivityAt.toISOString(),
    eventRef: `useagent://threads/${view.threadId}/runs/${view.latestRunId}/native-events`,
  };
}

export async function listChildSessions(input: {
  readonly orgId: string;
  readonly threadId: string;
  readonly limit?: unknown;
}): Promise<readonly ChildSessionSummary[]> {
  const limit = childSessionLimit(input.limit);
  const legacy = await listLegacyChildSessions(input.orgId, input.threadId, limit);
  if (productChildThreadsEnabled(input.orgId)) {
    const parent = await getThreadRelationship(input.orgId, input.threadId);
    if (!parent) return legacy;
    const children = (await listDirectThreadChildren({
      orgId: input.orgId,
      parentThreadId: parent.threadId,
      limit,
    })).map((child) => ({
      id: child.threadId,
      kind: "product_thread" as const,
      messageable: true,
      parentRunId: child.sourceRunId,
      threadId: child.threadId,
      status: child.status,
      promptPreview: child.title,
      engine: child.engine,
      model: child.model,
      createdAt: child.createdAt.toISOString(),
      updatedAt: child.latestActivityAt.toISOString(),
      eventRef: `useagent://threads/${child.threadId}/runs/${child.latestRunId}/native-events`,
    }));
    const merged = new Map<string, ChildSessionSummary>();
    for (const child of [...children, ...legacy]) if (!merged.has(child.id)) merged.set(child.id, child);
    return [...merged.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, limit);
  }
  return legacy;
}

async function listLegacyChildSessions(
  orgId: string,
  threadId: string,
  limit: number,
): Promise<readonly ChildSessionSummary[]> {
  const rows = await db
    .select({
      id: runs.id,
      parentRunId: runs.parentRunId,
      threadId: runs.threadId,
      status: runs.status,
      prompt: runs.prompt,
      engine: runs.engine,
      model: runs.model,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
    })
    .from(commands)
    .innerJoin(runs, eq(commands.runId, runs.id))
    .where(
      and(
        eq(commands.orgId, orgId),
        eq(commands.threadId, threadId),
        like(commands.idempotencyKey, `${childKeyPrefix(threadId)}%`),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit);
  return rows.map(toSummary);
}

export async function getChildSession(
  orgId: string,
  threadId: string,
  childRunId: string,
): Promise<ChildSessionSummary | null> {
  if (productChildThreadsEnabled(orgId)) {
    const parent = await getThreadRelationship(orgId, threadId);
    const child = await getThreadRelationship(orgId, childRunId);
    if (parent && child && child.parentThreadId === parent.threadId && child.kind !== "root") {
      return getProductChildSession(orgId, child.threadId);
    }
  }
  return getLegacyChildSession(orgId, threadId, childRunId);
}

async function getLegacyChildSession(
  orgId: string,
  threadId: string,
  childRunId: string,
): Promise<ChildSessionSummary | null> {
  const [row] = await db
    .select({
      id: runs.id,
      parentRunId: runs.parentRunId,
      threadId: runs.threadId,
      status: runs.status,
      prompt: runs.prompt,
      engine: runs.engine,
      model: runs.model,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
    })
    .from(commands)
    .innerJoin(runs, eq(commands.runId, runs.id))
    .where(
      and(
        eq(commands.orgId, orgId),
        eq(commands.threadId, threadId),
        eq(commands.runId, childRunId),
        like(commands.idempotencyKey, `${childKeyPrefix(threadId)}%`),
      ),
    )
    .limit(1);
  return row ? toSummary(row) : null;
}

export async function listChildSessionEvents(input: {
  readonly orgId: string;
  readonly threadId: string;
  readonly childRunId: string;
  readonly cursorRunId?: unknown;
  readonly cursor?: unknown;
  readonly limit?: unknown;
}): Promise<ChildSessionEventPage | null> {
  const child = await getChildSession(input.orgId, input.threadId, input.childRunId);
  if (!child) return null;
  const limit = childSessionEventLimit(input.limit);
  const productChild = productChildThreadsEnabled(input.orgId) && child.kind === "product_thread";
  const resolvedRunId = productChild
    ? (await getThreadRelationshipView(input.orgId, child.threadId))?.latestRunId ?? input.childRunId
    : input.childRunId;
  const cursor = typeof input.cursor === "number" && Number.isInteger(input.cursor) &&
    (!productChild || input.cursorRunId === resolvedRunId)
    ? input.cursor
    : -1;
  const [rows, eventCount] = await Promise.all([
    getNativeFramesSince(resolvedRunId, cursor, limit + 1),
    countNativeFrames(resolvedRunId),
  ]);
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit);
  const last = events.at(-1);
  return {
    childRunId: resolvedRunId,
    cursorRunId: resolvedRunId,
    events,
    nextCursor: hasMore && last ? last.seq : null,
    hasMore,
    eventCount,
    eventRef: productChild
      ? `useagent://threads/${child.threadId}/runs/${resolvedRunId}/native-events`
      : child.eventRef,
  };
}

export async function gatherChildSessions(input: {
  readonly orgId: string;
  readonly threadId: string;
  readonly limit?: unknown;
}): Promise<ReadonlyArray<ChildSessionSummary & {
  readonly eventCount: number;
  readonly latestEventTypes: readonly string[];
}>> {
  const children = await listChildSessions(input);
  if (children.length === 0) return [];
  if (productChildThreadsEnabled(input.orgId)) {
    const productChildren = children.filter((child) => child.kind === "product_thread");
    const legacyChildren = children.filter((child) => child.kind === "legacy_child_run");
    const childThreadIds = productChildren.map((child) => child.threadId);
    const eventRows = childThreadIds.length === 0 ? [] : await db.select({
      threadId: runs.threadId,
      count: sql<number>`count(*)::int`,
      latestTypes: sql<string[]>`(array_agg(${providerEvents.eventType} order by ${providerEvents.createdAt} desc, ${providerEvents.id} desc))[1:5]`,
    }).from(providerEvents).innerJoin(runs, eq(runs.id, providerEvents.runId)).where(and(
      eq(runs.orgId, input.orgId),
      inArray(runs.threadId, childThreadIds),
    )).groupBy(runs.threadId).orderBy(asc(runs.threadId));
    const eventsByThread = new Map(eventRows.map((row) => [row.threadId, row]));
    const legacyEventRows = legacyChildren.length === 0 ? [] : await db.select({
      runId: providerEvents.runId,
      count: sql<number>`count(*)::int`,
      latestTypes: sql<string[]>`(array_agg(${providerEvents.eventType} order by ${providerEvents.seq} desc))[1:5]`,
    }).from(providerEvents).where(inArray(providerEvents.runId, legacyChildren.map((child) => child.id)))
      .groupBy(providerEvents.runId).orderBy(asc(providerEvents.runId));
    const legacyEventsByRun = new Map(legacyEventRows.map((row) => [row.runId, row]));
    return Promise.all(children.map(async (child) => {
      if (child.kind === "legacy_child_run") {
        const legacyEvents = legacyEventsByRun.get(child.id);
        return {
          ...child,
          eventCount: legacyEvents?.count ?? 0,
          latestEventTypes: legacyEvents?.latestTypes ?? [],
        };
      }
      const view = await getThreadRelationshipView(input.orgId, child.threadId);
      if (!view) return { ...child, eventCount: 0, latestEventTypes: [] };
      const latest = await getRunForOrg(input.orgId, view.latestRunId);
      const rawResult = latest?.summary ?? "";
      let result = rawResult.slice(0, CHILD_RESULT_MAX_CHARS);
      while (Buffer.byteLength(result, "utf8") > 16 * 1024) result = result.slice(0, -1);
      const artifactRows = await listArtifactsForOrg({
        orgId: input.orgId,
        threadId: child.threadId,
        limit: CHILD_REFERENCE_PAGE_LIMIT + 1,
      });
      const finished = latest ? await listFinishedWorkForRun(input.orgId, latest.id) : { receipts: [] };
      const allCodeReferences = finished.receipts.flatMap((receipt) => {
        const metadata = receipt.metadata ?? {};
        const commitSha = typeof metadata.commitSha === "string" ? metadata.commitSha : null;
        const pullRequestUrl = typeof metadata.pullRequestUrl === "string" ? metadata.pullRequestUrl : null;
        return commitSha || pullRequestUrl ? [{ commit_sha: commitSha, pull_request_url: pullRequestUrl }] : [];
      });
      const codeReferences = allCodeReferences.slice(0, CHILD_REFERENCE_PAGE_LIMIT);
      return {
        ...child,
        eventCount: eventsByThread.get(child.threadId)?.count ?? 0,
        latestEventTypes: eventsByThread.get(child.threadId)?.latestTypes ?? [],
        result,
        resultTruncated: result.length < rawResult.length,
        artifacts: artifactRows.slice(0, CHILD_REFERENCE_PAGE_LIMIT).map((artifact) => ({
          artifact_id: artifact.id,
          revision: artifact.workpieceRevision,
          digest: artifact.sha256,
          preview_url: `/api/artifacts/${artifact.id}/content`,
          download_url: `/api/artifacts/${artifact.id}/content?download=1`,
        })),
        artifactsHasMore: artifactRows.length > CHILD_REFERENCE_PAGE_LIMIT,
        codeReferences,
        codeReferencesHasMore: allCodeReferences.length > codeReferences.length,
        codeHandoffAvailable: codeReferences.length > 0,
      };
    }));
  }
  const rows = await db
    .select({
      runId: providerEvents.runId,
      count: sql<number>`count(*)::int`,
      latestTypes: sql<string[]>`(array_remove(array_agg(${providerEvents.eventType} order by ${providerEvents.seq} desc), null))[1:5]`,
    })
    .from(providerEvents)
    .where(inArray(providerEvents.runId, children.map((child) => child.id)))
    .groupBy(providerEvents.runId)
    .orderBy(asc(providerEvents.runId));
  const byRun = new Map(rows.map((row) => [row.runId, row]));
  return children.map((child) => {
    const row = byRun.get(child.id);
    return {
      ...child,
      eventCount: row?.count ?? 0,
      latestEventTypes: row?.latestTypes ?? [],
    };
  });
}
