import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { db } from "../db/client";
import { providerEvents } from "../db/schema";
import { recordProviderEvent } from "./provider-events";

// ---------------------------------------------------------------------------
// Run-timing ledger (perf plan Phase 0): named stage spans/marks recorded
// through the EXISTING durable provider-event lane - no new subsystem. Rows are
// diagnostics only: the canonical translator suppresses `timing.*` with a named
// accounting reason, so they never become timeline nodes. Payloads carry ONLY
// stage names and epoch-ms numbers - never prompts, tokens, or credentials.
// Every write is fire-and-forget off the measured path: a timing failure must
// never slow or fail a run.
// ---------------------------------------------------------------------------

export const TIMING_PROVIDER = "skynet-timing";
export const TIMING_SPAN = "timing.span";
export const TIMING_MARK = "timing.mark";

export interface TimingSpanPayload {
  stage: string;
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms
  durMs: number;
}

export interface TimingMarkPayload {
  stage: string;
  at: number; // epoch ms
}

/** Injectable persistence seam so the span math is testable without a DB. */
export type TimingSink = (input: {
  id: string;
  runId: string;
  threadId: string;
  eventType: string;
  payload: TimingSpanPayload | TimingMarkPayload;
}) => void;

const defaultSink: TimingSink = (input) => {
  void recordProviderEvent({
    id: input.id,
    runId: input.runId,
    threadId: input.threadId,
    provider: TIMING_PROVIDER,
    eventType: input.eventType,
    payload: input.payload,
  });
};

/** Record a completed span (stable id per run+stage: a retried stage upserts). */
export function recordStageSpan(
  runId: string,
  threadId: string,
  stage: string,
  startedAt: number,
  endedAt: number,
  sink: TimingSink = defaultSink,
): void {
  sink({
    id: `${runId}:timing:${stage}`,
    runId,
    threadId,
    eventType: TIMING_SPAN,
    payload: { stage, startedAt, endedAt, durMs: Math.max(0, endedAt - startedAt) },
  });
}

/** Record an instantaneous milestone (e.g. prompt dispatch). */
export function recordStageMark(
  runId: string,
  threadId: string,
  stage: string,
  at: number,
  sink: TimingSink = defaultSink,
): void {
  sink({
    id: `${runId}:timing:${stage}`,
    runId,
    threadId,
    eventType: TIMING_MARK,
    payload: { stage, at },
  });
}

export interface RunStageTimer {
  /** Start a span; the returned closer records it (idempotent: first call wins). */
  begin(stage: string): () => void;
  /** Record an instantaneous milestone. */
  mark(stage: string): void;
}

/** Ergonomic per-run timer over the module helpers. Monotonic durations via
 *  performance.now(), anchored once to the wall clock at creation. */
export function createRunTimer(
  runId: string,
  threadId: string,
  sink: TimingSink = defaultSink,
): RunStageTimer {
  const wallOrigin = Date.now();
  const monoOrigin = performance.now();
  const now = (): number => wallOrigin + Math.round(performance.now() - monoOrigin);
  return {
    begin(stage) {
      const startedAt = now();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        recordStageSpan(runId, threadId, stage, startedAt, now(), sink);
      };
    },
    mark(stage) {
      recordStageMark(runId, threadId, stage, now(), sink);
    },
  };
}

// ---------------------------------------------------------------------------
// Derivation: shape persisted timing rows into the per-run developer table.
// Pure - the route supplies rows (and the first post-dispatch provider-event
// timestamp) so this stays hermetically testable.
// ---------------------------------------------------------------------------

export interface TimingRowInput {
  eventType: string;
  payload: unknown;
}

export interface TimingTableRow {
  stage: string;
  kind: "span" | "mark";
  startedAt: number;
  endedAt: number | null;
  durMs: number | null;
}

export interface TimingTable {
  rows: TimingTableRow[];
  /** dispatch mark epoch ms, when recorded. */
  dispatchAt: number | null;
  /** ms from dispatch to the first non-timing provider event, when both exist. */
  timeToFirstEventMs: number | null;
  /** total wall span across all recorded stages (first start to last end). */
  totalMs: number | null;
}

function parsePayload(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

export function deriveTimingTable(
  rows: TimingRowInput[],
  firstProviderEventAfterDispatchMs: number | null = null,
): TimingTable {
  const out: TimingTableRow[] = [];
  let dispatchAt: number | null = null;
  for (const row of rows) {
    const p = parsePayload(row.payload);
    if (!p || typeof p.stage !== "string") continue;
    if (row.eventType === TIMING_SPAN) {
      if (typeof p.startedAt !== "number" || typeof p.endedAt !== "number") continue;
      out.push({
        stage: p.stage,
        kind: "span",
        startedAt: p.startedAt,
        endedAt: p.endedAt,
        durMs: typeof p.durMs === "number" ? p.durMs : p.endedAt - p.startedAt,
      });
    } else if (row.eventType === TIMING_MARK) {
      if (typeof p.at !== "number") continue;
      out.push({ stage: p.stage, kind: "mark", startedAt: p.at, endedAt: null, durMs: null });
      if (p.stage === "dispatch") dispatchAt = p.at;
    }
  }
  out.sort((a, b) => a.startedAt - b.startedAt);
  const starts = out.map((r) => r.startedAt);
  const ends = out.flatMap((r) => (r.endedAt !== null ? [r.endedAt] : [r.startedAt]));
  const totalMs =
    starts.length > 0 ? Math.max(...ends) - Math.min(...starts) : null;
  const timeToFirstEventMs =
    dispatchAt !== null && firstProviderEventAfterDispatchMs !== null
      ? Math.max(0, firstProviderEventAfterDispatchMs - dispatchAt)
      : null;
  return { rows: out, dispatchAt, timeToFirstEventMs, totalMs };
}

/** Load one run's timing table from the durable lane. Dispatch-to-first-event is
 *  derived from the first NON-timing provider event persisted after the dispatch
 *  mark (persist time, not provider receipt - close enough for diagnostics and
 *  documented as such). */
export async function getRunTimingTable(runId: string): Promise<TimingTable> {
  const rows = await db
    .select({ eventType: providerEvents.eventType, payload: providerEvents.payload })
    .from(providerEvents)
    .where(and(eq(providerEvents.runId, runId), eq(providerEvents.provider, TIMING_PROVIDER)))
    .orderBy(asc(providerEvents.seq));
  const provisional = deriveTimingTable(rows);
  if (provisional.dispatchAt === null) return provisional;
  const [first] = await db
    .select({ at: sql<string | null>`min(${providerEvents.createdAt})` })
    .from(providerEvents)
    .where(
      and(
        eq(providerEvents.runId, runId),
        ne(providerEvents.provider, TIMING_PROVIDER),
        gt(providerEvents.createdAt, new Date(provisional.dispatchAt)),
      ),
    );
  const firstAt = first?.at ? new Date(first.at).getTime() : null;
  return deriveTimingTable(rows, Number.isFinite(firstAt) ? firstAt : null);
}
