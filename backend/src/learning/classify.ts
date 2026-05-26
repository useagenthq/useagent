import type { ExtractedProcedure } from "./procedure-v2";
import { hasVerificationStep } from "./procedure-v2";

// ---------------------------------------------------------------------------
// Candidate classification + verified-outcome gate (self_improving 6.4).
//
// "Provider completion alone is not success." A run reaching `completed` proves
// the ENGINE stopped, not that anything was accomplished. A PROCEDURE candidate
// (a reusable workflow) therefore requires a VERIFIED postcondition:
//   - a published artifact (durable output exists), OR
//   - a test/verification step succeeded, OR
//   - explicit user acceptance (a follow-up turn that did NOT correct this one).
//
// Given a verified outcome, the candidate kind follows the doc's ladder:
//   small preference            -> personal memory (reversible, low risk)
//   verified org fact           -> knowledge draft (human-review governed)
//   repeatable multi-step flow  -> playbook proposal (human-review governed)
//
// Nothing here auto-publishes: the classification only decides WHICH reviewable
// asset the outbox worker produces. Pure + deterministic. No LLM.
// ---------------------------------------------------------------------------

/** The observable facts the classifier reasons over — all durable at finalize. */
export interface OutcomeFacts {
  /** Which memory pool the run wrote (personal preferences stay personal). */
  scope: "personal" | "org";
  /** Published artifacts (a durable, verifiable output). */
  artifactCount: number;
  /** A test/typecheck/verify step succeeded in the executable procedure. */
  hasVerification: boolean;
  /** The follow-up turn accepted this run (a reply that did NOT correct it, or
   *  no follow-up needed). Explicit user acceptance per 6.4. */
  userAccepted: boolean;
  /** Total executable procedure steps (the reusable workflow length). */
  executableSteps: number;
  /** Distinct tools used across the executable procedure. */
  distinctTools: number;
}

/** A verified POSTCONDITION exists per 6.4: a published artifact, a passing
 *  verification step, or explicit user acceptance. Completion alone is NOT it. */
export function hasVerifiedOutcome(facts: OutcomeFacts): boolean {
  return facts.artifactCount >= 1 || facts.hasVerification || facts.userAccepted;
}

/** How many executable steps across how many distinct tools make a run a
 *  repeatable multi-step WORKFLOW (playbook), rather than a single fact. */
export const WORKFLOW_MIN_STEPS = 3;
export const WORKFLOW_MIN_DISTINCT_TOOLS = 2;

/** The reviewable asset a verified run should produce. `none` = the verified-
 *  outcome gate rejected it (no procedure candidate from an unverified run). */
export type CandidateClass = "none" | "personal_memory" | "knowledge_draft" | "playbook_proposal";

/**
 * Classify a completed run's learning outcome. Enforces the verified-outcome
 * gate FIRST: an unverified completion is `none` (produces no procedure
 * candidate). Then the doc's ladder:
 *   - a repeatable multi-step verified workflow -> a PLAYBOOK proposal
 *   - a verified org fact                       -> a KNOWLEDGE draft
 *   - a small personal-scope outcome            -> a PERSONAL-memory candidate
 * Pure + deterministic.
 */
export function classifyCandidate(facts: OutcomeFacts): CandidateClass {
  if (!hasVerifiedOutcome(facts)) return "none";

  const isWorkflow =
    facts.executableSteps >= WORKFLOW_MIN_STEPS &&
    facts.distinctTools >= WORKFLOW_MIN_DISTINCT_TOOLS;

  // Personal-scope runs stay personal (a user preference is reversible, low
  // risk, and never an org fact) UNLESS they are a genuine multi-step workflow,
  // which still becomes a reviewable playbook (never org-published without
  // human approval).
  if (facts.scope === "personal" && !isWorkflow) return "personal_memory";
  if (isWorkflow) return "playbook_proposal";
  return "knowledge_draft";
}

/** Convenience: build the classifier's facts from an extracted procedure + the
 *  run's outcome signals. Keeps the outbox worker's call site small. */
export function outcomeFactsFrom(input: {
  scope: "personal" | "org";
  artifactCount: number;
  userAccepted: boolean;
  procedure: ExtractedProcedure;
}): OutcomeFacts {
  const distinctTools = new Set(input.procedure.executable.map((s) => s.tool)).size;
  return {
    scope: input.scope,
    artifactCount: input.artifactCount,
    hasVerification: hasVerificationStep(input.procedure),
    userAccepted: input.userAccepted,
    executableSteps: input.procedure.executable.length,
    distinctTools,
  };
}
