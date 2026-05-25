import type { KnowledgeDraftReason } from "../db/schema";

// ---------------------------------------------------------------------------
// Deterministic run salience for the learning lane (item 4). Decides which
// COMPLETED runs are high-value enough to propose a reviewable knowledge draft
// from — pure facts in, verdict out, no LLM and no randomness, so the producer
// is testable and its judgments are reproducible. Self-contained by design
// (a parallel branch may grow its own src/memory salience; reconcile by
// swapping this module's callers, nothing here reaches into memory internals).
// ---------------------------------------------------------------------------

/** The observable facts the verdict is computed from. */
export interface RunSalienceFacts {
  /** The run's terminal status — only "completed" runs can be high-value. */
  status: string;
  /** Published artifacts the run produced (durable outputs = proven value). */
  artifactCount: number;
  /** Total recorded steps (the run's tool/command activity volume). */
  stepCount: number;
  /** Distinct step kinds — a "multi-tool" run used more than one capability. */
  distinctStepKinds: number;
}

/** A long multi-tool run: at least this many steps ... */
export const LONG_RUN_MIN_STEPS = 10;
/** ... across at least this many distinct step kinds. */
export const LONG_RUN_MIN_STEP_KINDS = 2;

/**
 * The reason a completed run counts as high-value, or null when it does not.
 * Precedence: published artifacts are the strongest signal (a durable output
 * exists), then long multi-tool activity. Pure and deterministic.
 */
export function highValueReason(facts: RunSalienceFacts): KnowledgeDraftReason | null {
  if (facts.status !== "completed") return null;
  if (facts.artifactCount >= 1) return "published_artifacts";
  if (
    facts.stepCount >= LONG_RUN_MIN_STEPS &&
    facts.distinctStepKinds >= LONG_RUN_MIN_STEP_KINDS
  ) {
    return "long_multi_tool_run";
  }
  return null;
}
