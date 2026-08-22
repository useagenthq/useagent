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
import { getNativeFramesSince, type NativeFrame } from "./native-events";
import { getRunForOrg } from "./repo";
import { createRunResourceAuthorization } from "../resources/authorization";
import {
  legacyParentResources,
  resolveRunIntake,
} from "../resources/run-intake";
import { isInternalRunOrigin } from "./origin";

export const CHILD_SESSION_IDEMPOTENCY_PREFIX = "child-session";

const MAX_CHILD_LIMIT = 20;
const MAX_EVENT_LIMIT = 50;

export interface ChildSessionSummary {
  readonly id: string;
  readonly parentRunId: string | null;
  readonly threadId: string;
  readonly status: RunStatus;
  readonly promptPreview: string;
  readonly engine: EngineId;
  readonly model: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly eventRef: string;
}

export interface ChildSessionEventPage {
  readonly childRunId: string;
  readonly events: readonly NativeFrame[];
  readonly nextCursor: number | null;
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

export async function createChildSession(input: {
  readonly orgId: string;
  readonly actorId: string | null;
  readonly parentRunId: string;
  readonly threadId: string;
  readonly prompt: string;
  readonly engine: EngineId;
  readonly model: string;
  readonly repos: readonly string[];
  readonly memoryScope: MemoryScope;
  readonly idempotencyKey: string;
}): Promise<{ readonly status: "created" | "replayed"; readonly child: ChildSessionSummary } | { readonly status: "conflict" }> {
  const runId = crypto.randomUUID();
  const idempotencyKey = childKey(
    input.threadId,
    input.parentRunId,
    input.idempotencyKey,
  );
  const intent: RunCommandIntent = {
    prompt: input.prompt,
    model: input.model,
    engine: input.engine,
    parentRunId: input.parentRunId,
    // Child sessions inherit the parent's already-authorized resources. They
    // cannot make an explicit repository selection of their own.
    requestedRepos: [],
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
  let accepted = internalOrigin
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
        parentRunId: input.parentRunId,
        threadId: input.threadId,
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
    };
    accepted = internalOrigin
      ? await acceptInternalRunCommand({ ...commandInput, origin: internalOrigin })
      : await acceptRunCommand(commandInput);
  }
  if (accepted.status === "conflict") return { status: "conflict" };
  const child = await getChildSession(input.orgId, input.threadId, accepted.runId);
  if (!child) throw new Error(`Accepted child session ${accepted.runId} was not readable`);
  return { status: accepted.status, child };
}

export async function listChildSessions(input: {
  readonly orgId: string;
  readonly threadId: string;
  readonly limit?: unknown;
}): Promise<readonly ChildSessionSummary[]> {
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
        eq(commands.orgId, input.orgId),
        eq(commands.threadId, input.threadId),
        like(commands.idempotencyKey, `${childKeyPrefix(input.threadId)}%`),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(childSessionLimit(input.limit));
  return rows.map(toSummary);
}

export async function getChildSession(
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
  readonly cursor?: unknown;
  readonly limit?: unknown;
}): Promise<ChildSessionEventPage | null> {
  const child = await getChildSession(input.orgId, input.threadId, input.childRunId);
  if (!child) return null;
  const cursor = typeof input.cursor === "number" && Number.isInteger(input.cursor) ? input.cursor : -1;
  const limit = childSessionEventLimit(input.limit);
  const rows = (await getNativeFramesSince(input.childRunId, cursor)).slice(0, limit + 1);
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit);
  const last = events.at(-1);
  return {
    childRunId: input.childRunId,
    events,
    nextCursor: hasMore && last ? last.seq : null,
    eventRef: child.eventRef,
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
