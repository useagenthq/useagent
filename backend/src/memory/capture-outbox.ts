import { eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { memoryOutbox, type MemoryOutboxState, type MemoryScope } from "../db/schema";
import { renderCaptureEvidence, type CaptureEvidence } from "./capture-evidence";
import { deliverTeamMemory, type MemoryIdentity } from "./team-memory";

// ---------------------------------------------------------------------------
// Durable capture outbox for team memory (memory Phase 3b) — persistence +
// delivery in one small module (one concern: reliably write a run's outcome to
// team memory). Replaces the old fire-and-forget POST that was lost on ANY
// failure. Mirrors slack_outbox's shape/backoff; kept SEPARATE by design (no
// shared outbox framework this cycle — convergence noted in the progress log).
//
// AT-MOST-once delivery: /v3/conversation/add has NO idempotency key, so a
// re-delivery would create a duplicate L0 turn. A row orphaned in `delivering`
// by a crash is therefore NEVER auto-reset to pending (no resetStuckDelivering —
// the opposite of the Slack outbox) — it awaits manual inspection. That trades a
// rare lost capture for never duplicating a team-memory turn.
//
// NOT every completed run lands here. Finalization (runs/finalize.ts) EXCLUDES
// INTERNAL runs (parity canaries, e2e/soak harnesses, QC probes) — marked
// first-class on runs.origin (src/runs/origin.ts) at command acceptance — so
// evaluation traffic never pollutes org memory. Non-SALIENT summaries (trivial
// one-liners, failure apologies, raw command output) are gated out by
// assessCaptureSalience (capture-salience.ts) before enqueue.
// ---------------------------------------------------------------------------

const PAYLOAD_CAP = 16_384;
const BASE_BACKOFF_MS = 30_000; // 30s, doubling
const MAX_BACKOFF_MS = 3_600_000; // capped at 1h

interface CapturePayload {
  readonly identity: MemoryIdentity;
  readonly prompt: string;
  readonly summary: string;
  /** The destination pool (personal|org). The `identity` already encodes it
   *  (its user_id IS the pool partition); this is the human-readable label, kept
   *  so a retry — which reuses this same committed payload — provably preserves
   *  the original destination scope. */
  readonly scope: MemoryScope;
  /** Structured verified-outcome facts (capture-evidence.ts): artifacts, tool
   *  counts, status/duration/engine/model, user-correction signal. Optional —
   *  pre-evidence rows (and captures with nothing to attest) omit it and still
   *  parse. Rendered into the delivered assistant turn at delivery time. */
  readonly evidence?: CaptureEvidence;
}

/** Next retry time: exponential backoff (30s·2^attempt), capped at 1h. Pure. */
export function backoffAt(now: number, attempt: number): Date {
  return new Date(now + Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS));
}

/** The row's state after a delivery outcome — retry until maxAttempts, then dead.
 *  Pure (the retry/dead policy), so it's unit-tested without a DB. */
export function nextOutboxState(
  ok: boolean,
  attemptCount: number,
  maxAttempts: number,
): "delivered" | "retry" | "dead" {
  if (ok) return "delivered";
  return attemptCount + 1 >= maxAttempts ? "dead" : "retry";
}

/**
 * Enqueue a run's captured outcome. Idempotent by runId (id = runId) — a
 * duplicate enqueue or a retried finalization never creates a second row, so a
 * capture is delivered AT MOST once per run. The committed row IS the durable
 * intent to deliver; the loop below does the (retryable) network call.
 */
export async function enqueueCapture(
  runId: string,
  identity: MemoryIdentity,
  run: { prompt: string; summary: string; evidence?: CaptureEvidence },
  /** The destination pool (personal|org) — recorded in the payload so a retry,
   *  which reuses this committed row verbatim, provably preserves the original
   *  destination scope. */
  scope: MemoryScope,
  /** Enqueue inside the run-finalization transaction (runs/finalize.ts) so the
   *  capture intent commits ATOMICALLY with the run reaching `completed` — a crash
   *  in the old completeRun→enqueue gap could otherwise lose it forever. Defaults
   *  to the shared pool for standalone callers. */
  exec: Executor = db,
): Promise<void> {
  const payload = buildCapturePayload(identity, run, scope);
  await exec
    .insert(memoryOutbox)
    .values({ id: runId, runId, payload })
    .onConflictDoNothing({ target: memoryOutbox.id });
}

/**
 * Serialize a capture envelope, capping at the FIELD level — never by slicing
 * the serialized string. A string slice mid-JSON produced an unparseable
 * payload that delivery dead-lettered, silently losing every over-cap capture
 * (external audit finding). Prompt and summary are the only unbounded fields;
 * shrink them until the whole envelope fits (JSON escaping can inflate, so
 * verify and re-shrink rather than assume). Pure — unit-tested directly.
 */
export function buildCapturePayload(
  identity: MemoryIdentity,
  run: { prompt: string; summary: string; evidence?: CaptureEvidence },
  scope: MemoryScope,
): string {
  let promptText = run.prompt;
  let summaryText = run.summary;
  for (let budget = PAYLOAD_CAP - 1_024; ; budget = Math.floor(budget * 0.8)) {
    promptText = promptText.slice(0, Math.ceil(budget / 2));
    summaryText = summaryText.slice(0, Math.ceil(budget / 2));
    const payload = JSON.stringify({
      identity,
      prompt: promptText,
      summary: summaryText,
      scope,
      // Evidence is bounded at collection (capped artifact list / name lengths),
      // so it never needs shrinking and the whole-envelope check below still
      // verifies the final size.
      ...(run.evidence ? { evidence: run.evidence } : {}),
    } satisfies CapturePayload);
    if (payload.length <= PAYLOAD_CAP || budget < 256) return payload;
  }
}

interface ClaimedRow {
  readonly id: string;
  readonly payload: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

/** Atomically claim due pending rows → `delivering` (CTE + FOR UPDATE SKIP
 *  LOCKED), so a concurrent worker can't double-send. Due is the DB clock. */
async function claimDue(limit: number): Promise<ClaimedRow[]> {
  const rows = (await db.execute(sql`
    with due as (
      select id from memory_outbox
      where state = 'pending' and next_attempt_at <= now()
      order by next_attempt_at asc
      limit ${limit}
      for update skip locked
    )
    update memory_outbox o set state = 'delivering', updated_at = now()
    from due where o.id = due.id
    returning o.id, o.payload, o.attempt_count, o.max_attempts`)) as unknown as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: r.id as string,
    payload: r.payload as string,
    attemptCount: Number(r.attempt_count),
    maxAttempts: Number(r.max_attempts),
  }));
}

async function markDelivered(id: string): Promise<void> {
  await db
    .update(memoryOutbox)
    .set({ state: "delivered", lastError: null, updatedAt: new Date() })
    .where(eq(memoryOutbox.id, id));
}

async function markRetry(id: string, nextAttemptAt: Date, lastError: string): Promise<void> {
  await db
    .update(memoryOutbox)
    .set({
      state: "pending",
      attemptCount: sql`${memoryOutbox.attemptCount} + 1`,
      nextAttemptAt,
      lastError: lastError.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(memoryOutbox.id, id));
}

async function markDead(id: string, lastError: string): Promise<void> {
  await db
    .update(memoryOutbox)
    .set({
      state: "dead",
      attemptCount: sql`${memoryOutbox.attemptCount} + 1`,
      lastError: lastError.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(memoryOutbox.id, id));
}

/**
 * Deliver up to `limit` due captures. Each claimed row is delivered via
 * deliverTeamMemory; the outcome routes it to delivered / retry (with backoff) /
 * dead (past maxAttempts). An unparseable payload is dead-lettered immediately
 * (never retried). Returns counts for the loop/tests. Never throws.
 */
export async function deliverDueCaptures(
  limit = 20,
): Promise<{ delivered: number; retried: number; dead: number }> {
  const rows = await claimDue(limit);
  let delivered = 0;
  let retried = 0;
  let dead = 0;
  for (const row of rows) {
    let parsed: CapturePayload | null = null;
    try {
      parsed = JSON.parse(row.payload) as CapturePayload;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      await markDead(row.id, "unparseable payload");
      dead++;
      continue;
    }
    // Verified-outcome evidence rides the assistant turn as a compact rendered
    // line — the memory wire accepts only role/content strings (team-memory.ts),
    // so composing here keeps the adapter untouched and old rows (no evidence)
    // deliver byte-identically.
    const summary = parsed.evidence
      ? `${parsed.summary}\n\n${renderCaptureEvidence(parsed.evidence)}`
      : parsed.summary;
    let ok = false;
    try {
      ok = await deliverTeamMemory({ prompt: parsed.prompt, summary }, parsed.identity);
    } catch {
      ok = false;
    }
    const outcome = nextOutboxState(ok, row.attemptCount, row.maxAttempts);
    if (outcome === "delivered") {
      await markDelivered(row.id);
      delivered++;
    } else if (outcome === "dead") {
      await markDead(row.id, "delivery failed after max attempts");
      dead++;
    } else {
      await markRetry(row.id, backoffAt(Date.now(), row.attemptCount + 1), "delivery failed");
      retried++;
    }
  }
  return { delivered, retried, dead };
}

/** Ops/test read helper — inspect a run's capture row (incl. crash-orphaned
 *  `delivering` rows, which are recovered manually, never auto-retried). */
export async function getCapture(runId: string) {
  const [row] = await db.select().from(memoryOutbox).where(eq(memoryOutbox.id, runId)).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Memory Hub admin surface — inspect + operate the capture outbox from the UI.
// The outbox has no org column (its id is a runId), so tenancy is enforced by
// JOINing memory_outbox.run_id → runs.id and filtering runs.org_id: an operator
// only ever sees / touches captures for runs in their own org. These power the
// /memory page's "Recently captured" section and its two manual-recovery paths.
// ---------------------------------------------------------------------------

/** One capture row shaped for the admin UI — outbox state + the payload envelope
 *  (destination scope + prompt/summary preview) WITHOUT the identity/credentials. */
export interface CaptureAdminRow {
  readonly runId: string;
  readonly state: MemoryOutboxState;
  readonly scope: MemoryScope | null;
  readonly promptPreview: string;
  readonly summaryPreview: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly nextAttemptAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const PREVIEW_CAP = 160;

/** Read the non-sensitive slice of a committed payload for the admin UI. Never
 *  exposes `identity` (carries the pool ids); tolerates a truncated/bad blob. */
function readPayloadPreview(payload: string): { scope: MemoryScope | null; prompt: string; summary: string } {
  try {
    const p = JSON.parse(payload) as Partial<CapturePayload>;
    return {
      scope: p.scope ?? null,
      prompt: (p.prompt ?? "").slice(0, PREVIEW_CAP),
      summary: (p.summary ?? "").slice(0, PREVIEW_CAP),
    };
  } catch {
    return { scope: null, prompt: "", summary: "" };
  }
}

/**
 * List an org's capture rows, newest first — every state, including the
 * crash-orphaned `delivering` rows that await manual inspection. Org-scoped by a
 * join to `runs`. `limit` caps the page.
 */
export async function listCapturesForOrg(orgId: string, limit = 50): Promise<CaptureAdminRow[]> {
  const rows = (await db.execute(sql`
    select o.id, o.state, o.payload, o.attempt_count, o.max_attempts,
           o.last_error, o.next_attempt_at, o.created_at, o.updated_at
    from memory_outbox o
    join runs r on r.id = o.run_id
    where r.org_id = ${orgId}
    order by o.updated_at desc
    limit ${limit}`)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const preview = readPayloadPreview(r.payload as string);
    return {
      runId: r.id as string,
      state: r.state as MemoryOutboxState,
      scope: preview.scope,
      promptPreview: preview.prompt,
      summaryPreview: preview.summary,
      attemptCount: Number(r.attempt_count),
      maxAttempts: Number(r.max_attempts),
      lastError: (r.last_error as string | null) ?? null,
      nextAttemptAt: new Date(r.next_attempt_at as string).toISOString(),
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    } satisfies CaptureAdminRow;
  });
}

/**
 * Manually re-enqueue a DEAD capture: reset it to `pending` with a fresh attempt
 * budget so the delivery loop picks it up now. The committed payload is reused
 * VERBATIM (its `scope` + `identity` unchanged), so the retry provably preserves
 * the original destination pool — idempotency of the capture is intact. Guarded
 * on state='dead' AND org ownership; returns false when nothing matched (wrong
 * org, wrong state, or gone).
 */
export async function retryDeadCapture(runId: string, orgId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    update memory_outbox o
    set state = 'pending', attempt_count = 0, next_attempt_at = now(),
        last_error = null, updated_at = now()
    from runs r
    where o.run_id = r.id and o.id = ${runId} and r.org_id = ${orgId}
      and o.state = 'dead'
    returning o.id`)) as unknown as Array<Record<string, unknown>>;
  return rows.length > 0;
}

/** Resolution for a crash-orphaned `delivering` row. `delivered` = the operator
 *  confirms it DID land (accept, at-most-once holds); `discard` = it did NOT land
 *  / abandon it (dead-letter). Both are explicit human decisions — the outbox
 *  never auto-resolves a `delivering` orphan. */
export type OrphanResolution = "delivered" | "discard";

/**
 * Resolve a crash-orphaned `delivering` capture per an explicit operator
 * decision. Guarded on state='delivering' AND org ownership. Returns false when
 * nothing matched. This is the documented manual-inspection path for the
 * at-most-once outbox made operable.
 */
export async function resolveDeliveringOrphan(
  runId: string,
  orgId: string,
  resolution: OrphanResolution,
): Promise<boolean> {
  const nextState = resolution === "delivered" ? "delivered" : "dead";
  const note =
    resolution === "delivered"
      ? "manually resolved: operator confirmed delivered"
      : "manually discarded: delivering orphan abandoned";
  const rows = (await db.execute(sql`
    update memory_outbox o
    set state = ${nextState}, last_error = ${note}, updated_at = now()
    from runs r
    where o.run_id = r.id and o.id = ${runId} and r.org_id = ${orgId}
      and o.state = 'delivering'
    returning o.id`)) as unknown as Array<Record<string, unknown>>;
  return rows.length > 0;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the delivery loop (idempotent). Best-effort: a tick failure is logged,
 *  never thrown; memory disabled is safe (deliverTeamMemory no-ops to success).
 *  `MEMORY_OUTBOX_TICK_MS` overrides the interval (tests/E2E go fast; mirrors
 *  SLACK_OUTBOX_TICK_MS). */
export function startCaptureDelivery(
  intervalMs = Number(process.env.MEMORY_OUTBOX_TICK_MS ?? 15_000),
): void {
  if (timer) return;
  timer = setInterval(() => {
    void deliverDueCaptures().catch((err) =>
      console.error("[memory-outbox] delivery tick failed:", err),
    );
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
