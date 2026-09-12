import { ENGINE_IDS, type EngineId } from "./wire";

export const THREAD_RELATIONSHIP_KINDS = [
  "root",
  "delegated",
  "continued_from_native",
] as const;
export type ThreadRelationshipKind = (typeof THREAD_RELATIONSHIP_KINDS)[number];

export const PRODUCT_THREAD_STATUSES = [
  "queued",
  "waiting",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ProductThreadStatus = (typeof PRODUCT_THREAD_STATUSES)[number];

export interface HandoffOutcome {
  readonly sourceRunId: string;
  readonly status: ProductThreadStatus;
  readonly summary: string | null;
}

/** Browser-safe hierarchy metadata for one ordinary, messageable product thread. */
export interface ThreadRelationship {
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly familyThreadId: string;
  readonly kind: ThreadRelationshipKind;
  readonly title: string;
  readonly sourceRunId: string;
  readonly sourceExecutionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: ProductThreadStatus;
  readonly engine: EngineId;
  readonly model: string;
  readonly latestRunId: string;
  readonly latestSummary: string | null;
  readonly latestDurationMs: number | null;
  readonly latestActivityAt: string;
  /** The bot this thread was handed to through an @mention; null otherwise. */
  readonly bot: {
    readonly id: string;
    readonly name: string;
    /** Additive bot-orb identity fields; omitted by older backends. */
    readonly avatarTone?: string;
    readonly avatarIcon?: string;
  } | null;
  /** Exact child turn admitted by each parent-run bot mention. */
  readonly handoffOutcomes?: readonly HandoffOutcome[];
  /** Parent-thread runs whose later @mention became a turn of this thread. */
  readonly followUpRunIds: readonly string[];
}

export interface ThreadFamilyPage {
  readonly children: readonly ThreadRelationship[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : string(value) ?? undefined;
}

/** Additive fields: an older backend omits them, which decodes as "no bot". */
function handoffBot(value: unknown): ThreadRelationship["bot"] | undefined {
  if (value === undefined || value === null) return null;
  const raw = record(value);
  const id = raw ? string(raw.id) : null;
  const name = raw ? string(raw.name) : null;
  if (!id || !name) return undefined;
  const avatarTone = string(raw?.avatarTone);
  const avatarIcon = string(raw?.avatarIcon);
  if ((raw?.avatarTone !== undefined && !avatarTone) || (raw?.avatarIcon !== undefined && !avatarIcon)) {
    return undefined;
  }
  return {
    id,
    name,
    ...(avatarTone ? { avatarTone } : {}),
    ...(avatarIcon ? { avatarIcon } : {}),
  };
}

function runIdList(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value as string[];
}

function handoffOutcomeList(value: unknown): HandoffOutcome[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const outcomes: HandoffOutcome[] = [];
  for (const item of value) {
    const raw = record(item);
    const sourceRunId = string(raw?.source_run_id);
    const summary = additiveNullableString(raw?.summary);
    if (
      !sourceRunId ||
      !(PRODUCT_THREAD_STATUSES as readonly unknown[]).includes(raw?.status) ||
      summary === undefined
    ) return undefined;
    outcomes.push({
      sourceRunId,
      status: raw?.status as ProductThreadStatus,
      summary,
    });
  }
  return outcomes;
}

/** Additive summary fields: a backend from before they were emitted omits them,
 *  which decodes as "no summary yet" rather than rejecting the whole relationship. */
function additiveNullableString(value: unknown): string | null | undefined {
  return value === undefined ? null : nullableString(value);
}

function additiveNullableNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export function decodeThreadRelationship(value: unknown): ThreadRelationship | null {
  const raw = record(value);
  if (!raw) return null;
  const threadId = string(raw.thread_id);
  const parentThreadId = nullableString(raw.parent_thread_id);
  const familyThreadId = string(raw.family_thread_id);
  const title = string(raw.title);
  const sourceRunId = string(raw.source_run_id);
  const sourceExecutionId = nullableString(raw.source_execution_id);
  const createdAt = string(raw.created_at);
  const updatedAt = string(raw.updated_at);
  const model = string(raw.model);
  const latestRunId = string(raw.latest_run_id);
  const latestSummary = additiveNullableString(raw.latest_summary);
  const latestDurationMs = additiveNullableNonNegativeInteger(raw.latest_duration_ms);
  const latestActivityAt = string(raw.latest_activity_at);
  const bot = handoffBot(raw.bot);
  const handoffOutcomes = handoffOutcomeList(raw.handoff_outcomes);
  const followUpRunIds = runIdList(raw.follow_up_run_ids);
  if (
    !threadId ||
    parentThreadId === undefined ||
    !familyThreadId ||
    !(THREAD_RELATIONSHIP_KINDS as readonly unknown[]).includes(raw.kind) ||
    !title ||
    !sourceRunId ||
    sourceExecutionId === undefined ||
    !createdAt ||
    !updatedAt ||
    !(PRODUCT_THREAD_STATUSES as readonly unknown[]).includes(raw.status) ||
    !(ENGINE_IDS as readonly unknown[]).includes(raw.engine) ||
    !model ||
    !latestRunId ||
    latestSummary === undefined ||
    latestDurationMs === undefined ||
    !latestActivityAt ||
    bot === undefined ||
    handoffOutcomes === undefined ||
    followUpRunIds === undefined
  ) return null;
  return {
    threadId,
    parentThreadId,
    familyThreadId,
    kind: raw.kind as ThreadRelationshipKind,
    title,
    sourceRunId,
    sourceExecutionId,
    createdAt,
    updatedAt,
    status: raw.status as ProductThreadStatus,
    engine: raw.engine as EngineId,
    model,
    latestRunId,
    latestSummary,
    latestDurationMs,
    latestActivityAt,
    bot,
    handoffOutcomes,
    followUpRunIds,
  };
}

export function decodeThreadRelationshipEnvelope(value: unknown): ThreadRelationship | null {
  const envelope = record(value);
  return decodeThreadRelationship(envelope?.relationship);
}

export function decodeThreadFamilyPage(value: unknown): ThreadFamilyPage | null {
  const envelope = record(value);
  if (!envelope || !Array.isArray(envelope.children) || typeof envelope.has_more !== "boolean") {
    return null;
  }
  const nextCursor = nullableString(envelope.next_cursor);
  if (nextCursor === undefined) return null;
  const children = envelope.children.map(decodeThreadRelationship);
  if (children.some((child) => child === null)) return null;
  return {
    children: children as ThreadRelationship[],
    nextCursor,
    hasMore: envelope.has_more,
  };
}
