// ---------------------------------------------------------------------------
// Capture salience gate (memory self-improvement item 3): a completed exchange
// becomes durable org memory ONLY when its summary is actually worth
// remembering. v1 is a cheap, DETERMINISTIC heuristic — no LLM call.
//
// Contract (stable so a model-based scorer can replace the body later):
//   assessCaptureSalience({ prompt, summary }) -> { salient, reason }
// The candidate carries the prompt for a future scorer even though v1 only
// judges the summary. Pure and synchronous; every capture path (run
// finalization, chat) MUST route through this one function.
// ---------------------------------------------------------------------------

/** One capture candidate: the exchange as it would be written to memory. */
export interface SalienceCandidate {
  readonly prompt: string;
  readonly summary: string;
}

/** The gate's verdict. `reason` is machine-readable for tests/logging and for
 *  comparing a future model scorer against the heuristic baseline. */
export interface SalienceDecision {
  readonly salient: boolean;
  readonly reason:
    | "empty-summary"
    | "trivial-acknowledgment"
    | "failure-apology"
    | "command-output"
    | "salient";
}

/** Leading apology/inability prose — a completed run whose summary is an
 *  apology carries no reusable fact. */
const APOLOGY_START = /^(i'?m sorry|sorry[\s,.!]|sorry$|i apologi[sz]e|my apologies)/i;
const INABILITY_START = /^unfortunately\b/i;
const INABILITY_WORDS = /\b(unable|couldn'?t|could not|cannot|can'?t|failed|no longer possible)\b/i;

/** A line that reads as raw shell transcript ("$ cmd" prompt echo or a set -x
 *  "+ cmd" trace). Markdown headings/quotes intentionally do NOT match. */
const SHELL_LINE = /^(\$|\+)\s/;

/**
 * Decide whether a completed exchange is worth remembering. v1 heuristics:
 *   - empty / whitespace-only summaries are skipped;
 *   - trivial one-liners ("OK", "Done.", single tokens) are skipped;
 *   - failure apologies ("I'm sorry, I couldn't ...") are skipped;
 *   - pure command output (letterless dumps, mostly shell-transcript lines)
 *     is skipped;
 *   - everything else is salient.
 * Deterministic and pure — replace the BODY with a model scorer later, keep the
 * signature.
 */
export function assessCaptureSalience(candidate: SalienceCandidate): SalienceDecision {
  const summary = candidate.summary.trim();
  if (summary.length === 0) return { salient: false, reason: "empty-summary" };

  // Trivial acknowledgment: a few short words with no substance to recall.
  const bare = summary.replace(/[.!?…]+$/u, "").trim();
  const words = bare.split(/\s+/).filter(Boolean);
  if (words.length <= 3 && bare.length < 30) {
    return { salient: false, reason: "trivial-acknowledgment" };
  }

  // Failed-run apology prose (a run can complete "successfully" and still only
  // apologize) — nothing verifiable to remember.
  if (
    APOLOGY_START.test(summary) ||
    (INABILITY_START.test(summary) && INABILITY_WORDS.test(summary.slice(0, 200)))
  ) {
    return { salient: false, reason: "failure-apology" };
  }

  // Pure command output: no letters at all, or a text that is mostly verbatim
  // shell-transcript lines.
  if (!/\p{L}/u.test(summary)) return { salient: false, reason: "command-output" };
  const lines = summary.split("\n").filter((line) => line.trim().length > 0);
  const shellLines = lines.filter((line) => SHELL_LINE.test(line.trim())).length;
  if (shellLines >= 2 && shellLines / lines.length >= 0.7) {
    return { salient: false, reason: "command-output" };
  }

  return { salient: true, reason: "salient" };
}
