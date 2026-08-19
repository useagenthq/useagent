import { and, count, eq, ne } from "drizzle-orm";
import type { Executor } from "../db/client";
import { artifacts, runs, steps, type RunStatus } from "../db/schema";

// ---------------------------------------------------------------------------
// Capture evidence (memory self-improvement item 5): a durable memory should
// carry VERIFIED outcomes, not just final prose. At finalize time the run's row
// and event log already hold structured proof — artifacts published, tools
// used, status/duration/engine/model, and whether the turn was a user
// correction — so the capture payload records it alongside prompt+summary.
// Delivery renders it as a compact text line appended to the assistant turn
// (the memory service accepts plain role/content messages — team-memory.ts —
// so this stays wire-compatible). Best-effort like all memory work: a failure
// here must never fail a run, and old payloads without evidence still parse.
// ---------------------------------------------------------------------------

/** One published artifact, as evidence: what it is called and what kind. */
export interface CaptureArtifactEvidence {
  readonly name: string;
  readonly kind: string;
}

/** Structured, verifiable facts about how an exchange concluded. All fields
 *  beyond `source`/`status` are optional so the chat surface (no sandbox, no
 *  steps/artifacts) shares the shape. */
export interface CaptureEvidence {
  /** Which surface produced the exchange: a sandboxed run or lightweight chat. */
  readonly source: "run" | "chat";
  readonly status: RunStatus;
  readonly engine?: string;
  readonly model?: string;
  readonly durationMs?: number;
  /** Artifacts the run published (name + kind), capped at {@link MAX_ARTIFACTS}. */
  readonly artifacts?: readonly CaptureArtifactEvidence[];
  /** Executed steps by kind (command/file/task) — how the outcome was produced. */
  readonly toolCounts?: Readonly<Record<string, number>>;
  /** The turn reads as the user CORRECTING the previous turn (parent failed, or
   *  the reply prompt carries corrective language). */
  readonly userCorrection?: boolean;
}

/** Bounds keeping the evidence a small, capped slice of the outbox payload. */
const MAX_ARTIFACTS = 10;
const MAX_NAME_CHARS = 120;
const MAX_KIND_CHARS = 60;
const MAX_RENDER_CHARS = 600;

/** Corrective reply language — deliberately narrow phrases that read as "the
 *  previous answer was wrong", NOT task verbs like a root "fix this bug". */
const CORRECTIVE_LANGUAGE =
  /\b(that('s| is| was) (wrong|incorrect|not right)|not what i (asked|meant|wanted)|you (made a mistake|got it wrong|misunderstood)|try again|redo (that|this|it)|wrong (answer|file|branch|repo))\b|^\s*actually[,\s]/i;

/**
 * Whether a turn is a user correction: only a REPLY can be one (parentStatus is
 * null for a thread root / chat), and it is one when the parent turn failed or
 * the reply prompt carries corrective language. Pure — unit-tested directly.
 */
export function detectUserCorrection(prompt: string, parentStatus: RunStatus | null): boolean {
  if (parentStatus === null) return false;
  if (parentStatus === "failed") return true;
  return CORRECTIVE_LANGUAGE.test(prompt);
}

/**
 * Render evidence as ONE compact bracketed line for the delivered assistant
 * message. Plain text (the memory wire accepts only role/content strings),
 * deterministic, bounded to {@link MAX_RENDER_CHARS}. Pure.
 */
export function renderCaptureEvidence(evidence: CaptureEvidence): string {
  const head = [`source=${evidence.source}`, `status=${evidence.status}`];
  if (evidence.engine) head.push(`engine=${evidence.engine}`);
  if (evidence.model) head.push(`model=${evidence.model}`);
  if (evidence.durationMs !== undefined) {
    head.push(
      `duration=${
        evidence.durationMs < 1000 ? `${evidence.durationMs}ms` : `${Math.round(evidence.durationMs / 1000)}s`
      }`,
    );
  }
  const parts = [head.join(" ")];
  const toolEntries = Object.entries(evidence.toolCounts ?? {});
  if (toolEntries.length > 0) {
    parts.push(`tools: ${toolEntries.map(([kind, n]) => `${kind} x${n}`).join(", ")}`);
  }
  if (evidence.artifacts && evidence.artifacts.length > 0) {
    parts.push(`artifacts: ${evidence.artifacts.map((a) => `${a.name} (${a.kind})`).join(", ")}`);
  }
  if (evidence.userCorrection) parts.push("user correction of the previous turn");
  return `[verified outcome] ${parts.join("; ")}`.slice(0, MAX_RENDER_CHARS);
}

/**
 * Gather a completed run's evidence inside the finalization transaction: step
 * counts by kind (the `done` marker excluded), published artifacts (name +
 * kind, capped), and the correction signal from the parent turn's status + the
 * reply prompt. All three reads are per-run indexed lookups — cheap enough for
 * the finalize transaction.
 */
export async function collectRunEvidence(
  run: {
    id: string;
    prompt: string;
    engine: string;
    model: string;
    parentRunId: string | null;
  },
  status: RunStatus,
  durationMs: number,
  exec: Executor,
): Promise<CaptureEvidence> {
  const stepRows = await exec
    .select({ kind: steps.kind, n: count() })
    .from(steps)
    .where(and(eq(steps.runId, run.id), ne(steps.kind, "done")))
    .groupBy(steps.kind);
  const toolCounts = Object.fromEntries(stepRows.map((r) => [r.kind, Number(r.n)]));

  const artifactRows = await exec
    .select({
      name: artifacts.name,
      contentType: artifacts.contentType,
      workpieceKind: artifacts.workpieceKind,
    })
    .from(artifacts)
    .where(eq(artifacts.runId, run.id))
    .orderBy(artifacts.createdAt)
    .limit(MAX_ARTIFACTS);
  const published = artifactRows.map((a) => ({
    name: a.name.slice(0, MAX_NAME_CHARS),
    kind: (a.workpieceKind ?? a.contentType).slice(0, MAX_KIND_CHARS),
  }));

  let parentStatus: RunStatus | null = null;
  if (run.parentRunId) {
    const [parent] = await exec
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, run.parentRunId))
      .limit(1);
    parentStatus = parent?.status ?? null;
  }

  return {
    source: "run",
    status,
    engine: run.engine,
    model: run.model,
    durationMs,
    ...(published.length > 0 ? { artifacts: published } : {}),
    ...(Object.keys(toolCounts).length > 0 ? { toolCounts } : {}),
    ...(detectUserCorrection(run.prompt, parentStatus) ? { userCorrection: true } : {}),
  };
}
