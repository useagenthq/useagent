import type { StepKind } from "../db/schema";
import type { SecretRedactor } from "../secrets/redact";

// ---------------------------------------------------------------------------
// Evidence Model v2 (self_improving 6.2 / 6.3). The old procedure trace
// (memory/procedure-trace.ts) recorded a flat tool/gist/ok list and the old
// backbone (learning/similarity.ts) generalized it by DEDUPING on tool name,
// which the doc FORBIDS. This module replaces both for the learning lane:
//
//   1. keep canonical step ORDER
//   2. keep MULTIPLE calls to the same tool (never set-dedup)
//   3. EXCLUDE failed/reverted steps from the executable procedure...
//   4. ...but RETAIN them as advice (recovery paths), not executable steps
//   5. PARAMETERIZE run-specific ids / PR numbers / branches / orgs / sandbox ids
//   6. preserve verification / cleanup / rollback / artifact-publish steps
//   7. cite the sourceEventIds (the step-row ids) used to build every step
//   8. cap by semantic phases, not by dropping the final tail
//
// Cross-candidate generalization uses SEQUENCE ALIGNMENT over normalized step
// signatures (a majority backbone that preserves REPEATED positions), NOT set
// intersection. Everything here is pure: same inputs, same output, no LLM.
// ---------------------------------------------------------------------------

/** One executable step of a run's procedure, per self_improving 6.2. */
export interface ProcedureStep {
  /** Position in the canonical (idx-ordered) trace, 0-based. Repeats are kept. */
  ordinal: number;
  /** The tool that ran (bash/edit/task/...), read from the step payload. */
  tool: string;
  /** What the tool did, one generalized line (command/path/description). */
  operation: string;
  /** Generalized, run-specific ids stripped — the reusable argument surface. */
  normalizedArgs: Record<string, unknown>;
  /** Human preconditions inferred deterministically (e.g. "a sandbox exists"). */
  preconditions: string[];
  /** Terminal outcome. `reverted` = a later step undid this one's effect. */
  result: "succeeded" | "failed" | "reverted" | "unknown";
  /** Canonical events proving the postcondition of this step (artifact/test). */
  verificationRefs: string[];
  /** The durable step-row ids this step was built from (provenance). */
  sourceEventIds: string[];
}

/** The extracted procedure: the EXECUTABLE path (succeeded + unknown steps in
 *  order, repeats preserved) plus ADVICE (the failed/reverted recovery steps,
 *  retained but never executed). */
export interface ExtractedProcedure {
  executable: ProcedureStep[];
  advice: ProcedureStep[];
  /** Steps beyond the phase cap, elided honestly (never a silent tail drop). */
  elided: number;
}

/** The slice of a durable step row v2 extraction reads. `id` is the step-row id
 *  cited as a sourceEventId. */
export interface StepSourceRow {
  id: string;
  kind: StepKind;
  label: string;
  chip: string | null;
  codeJson: string | null;
}

// --- Payload parsing ---------------------------------------------------------

interface StepCode {
  tool?: unknown;
  title?: unknown;
  input?: unknown;
  error?: unknown;
  status?: unknown;
}

const readString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v : undefined;

function parseCode(codeJson: string | null): StepCode {
  if (!codeJson) return {};
  try {
    const parsed: unknown = JSON.parse(codeJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as StepCode)
      : {};
  } catch {
    return {};
  }
}

const MAX_TOOL_CHARS = 40;
const MAX_OP_CHARS = 160;
/** Hard bound on how many steps a single run contributes to a candidate. Unlike
 *  the old trace this caps by keeping the leading semantic phases; the count of
 *  what was elided is reported, never silently dropped. */
export const MAX_PROCEDURE_STEPS = 60;

function oneLine(v: string, cap: number): string {
  return v.replace(/\s+/g, " ").trim().slice(0, cap).trim();
}

// --- Run-specific id parameterization (rule 5) -------------------------------
// The doc calls out ids, PR numbers, branches, orgs, sandbox ids specifically.

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PREFIXED_ID_RE = /\b[a-z]+_[A-Za-z0-9]{6,}\b/g; // ses_, run_, sb_, org_ ...
const HEX_ID_RE = /\b[0-9a-f]{8,}\b/gi;
/** A branch ref after a git verb (checkout/switch/push origin/branch -b ...). */
const BRANCH_RE = /\b(checkout|switch|branch(?:\s+-[a-zA-Z])?|push\s+origin|pull\s+origin)\s+(?!-)([A-Za-z0-9._][A-Za-z0-9._\/-]{2,})/g;
/** A PR/MR/issue number after # or a `pr view`/`--pr` style flag. */
const PR_NUMBER_RE = /(#|\b(?:pr|mr|issue|pull)\s+(?:view\s+|checkout\s+)?)(\d{1,7})\b/gi;
/** A long bare number (5+ digits) that is not a short stable argument. */
const LONG_NUMBER_RE = /\b\d{5,}\b/g;

/** Generalize a run-specific string for reuse: strip ids/branches/PR numbers.
 *  Short stable arguments (ports, small counts, flag names, paths, repo names)
 *  survive. Pure. */
export function parameterize(text: string): string {
  return text
    .replace(UUID_RE, "<id>")
    .replace(PREFIXED_ID_RE, "<id>")
    .replace(BRANCH_RE, (_m, verb: string) => `${verb} <branch>`)
    .replace(PR_NUMBER_RE, (_m, lead: string) => `${lead}<n>`)
    .replace(HEX_ID_RE, "<id>")
    .replace(LONG_NUMBER_RE, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Operation classification ------------------------------------------------

/** Verbs whose steps must survive extraction even when a tail cap bites, and
 *  which mark the step as a verification/cleanup/artifact postcondition. */
const VERIFY_RE = /\b(test|typecheck|lint|assert|verify|check|healthcheck|status)\b/i;
const PUBLISH_RE = /\b(pr create|pull request|publish|deploy|upload|artifact|release|commit|push)\b/i;
const ROLLBACK_RE = /\b(revert|rollback|reset --hard|git reset|restore|undo|delete|rm )\b/i;

/** The step's operation gist, most-specific first: command line, file path,
 *  subagent description, then the adapter title/label. Never raw output. */
function operationOf(code: StepCode, label: string): string {
  const input =
    code.input && typeof code.input === "object" && !Array.isArray(code.input)
      ? (code.input as Record<string, unknown>)
      : {};
  return (
    readString(input.command) ??
    readString(input.filePath) ??
    readString((input as Record<string, unknown>).file_path) ??
    readString(input.path) ??
    readString((input as Record<string, unknown>).abs_path) ??
    readString(input.description) ??
    readString(code.title) ??
    label
  );
}

/** The normalized argument surface: the raw input object, each string value
 *  parameterized + redacted. Kept small (the reusable knobs, not raw output). */
function normalizeArgs(code: StepCode, redact: SecretRedactor): Record<string, unknown> {
  const input =
    code.input && typeof code.input === "object" && !Array.isArray(code.input)
      ? (code.input as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") out[k] = parameterize(redact.text(v)).slice(0, MAX_OP_CHARS);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    // objects/arrays are dropped: too large, and not a reusable knob.
  }
  return out;
}

/** Deterministic preconditions from the tool/operation. Kept intentionally
 *  small: a sandbox for command steps, a checkout for git steps. */
function preconditionsOf(tool: string, operation: string): string[] {
  const pre: string[] = [];
  if (tool === "bash" || tool === "command") pre.push("a sandbox with the workdir checked out exists");
  if (/\bgit\b|\bgh\b/.test(operation)) pre.push("the repository is cloned and authenticated");
  return pre;
}

/**
 * Extract a run's procedure v2 from its ordered step rows. Order preserved,
 * repeats kept, failed/reverted steps split OUT of the executable path (retained
 * as advice), ids parameterized, verification/publish steps flagged, and each
 * step cites its source step-row id. The `done` marker is excluded. Pure — the
 * DB read lives at the caller. `reverted` is set when a later ROLLBACK step
 * targets the same normalized operation (a best-effort, deterministic pass).
 */
export function extractProcedure(
  rows: readonly StepSourceRow[],
  redact: SecretRedactor,
): ExtractedProcedure {
  const toolRows = rows.filter((r) => r.kind !== "done");
  const kept = toolRows.slice(0, MAX_PROCEDURE_STEPS);

  const steps: ProcedureStep[] = kept.map((row, ordinal) => {
    const code = parseCode(row.codeJson);
    const tool = oneLine(readString(code.tool) ?? row.chip ?? row.kind, MAX_TOOL_CHARS);
    const operation = oneLine(parameterize(redact.text(operationOf(code, row.label))), MAX_OP_CHARS);
    const failed = code.error === true || code.status === "failed";
    return {
      ordinal,
      tool,
      operation,
      normalizedArgs: normalizeArgs(code, redact),
      preconditions: preconditionsOf(tool, operation),
      result: failed ? ("failed" as const) : ("succeeded" as const),
      verificationRefs: [],
      sourceEventIds: [row.id],
    };
  });

  // Reverted pass (rule 3/4): a later ROLLBACK step whose operation names an
  // earlier step's operation gist marks that earlier step reverted, so it falls
  // out of the executable path with its undo retained as advice.
  for (const step of steps) {
    if (step.result !== "succeeded") continue;
    if (!ROLLBACK_RE.test(step.operation)) continue;
    for (const earlier of steps) {
      if (earlier.ordinal >= step.ordinal || earlier.result !== "succeeded") continue;
      if (step.operation.includes(earlier.operation) && earlier.operation.length >= 4) {
        earlier.result = "reverted";
      }
    }
  }

  // Verification refs (rule 6/7): a verify/publish step is its own postcondition
  // proof, so it cites itself as a verificationRef on the steps it follows in the
  // same run. We keep it simple + honest: a verify/publish step references ITSELF.
  for (const step of steps) {
    if (VERIFY_RE.test(step.operation) || PUBLISH_RE.test(step.operation)) {
      step.verificationRefs = [...step.sourceEventIds];
    }
  }

  const executable = steps.filter((s) => s.result === "succeeded" || s.result === "unknown");
  const advice = steps.filter((s) => s.result === "failed" || s.result === "reverted");
  return { executable, advice, elided: toolRows.length - kept.length };
}

/** Whether a run's procedure carried at least one verification/publish step —
 *  the executable postcondition the verified-outcome gate (6.4) looks for. */
export function hasVerificationStep(proc: ExtractedProcedure): boolean {
  return proc.executable.some((s) => s.verificationRefs.length > 0);
}

// ---------------------------------------------------------------------------
// Sequence alignment (self_improving 6.3) — generalize ACROSS runs by aligning
// ordered traces, NOT by set intersection. The signature of a step is
// tool+operation; the backbone keeps a step at a position when a MAJORITY of the
// aligned traces agree there, which preserves REPEATED positions (two `bash`
// calls in a row survive as two positions, never collapsed to one).
// ---------------------------------------------------------------------------

/** The alignment token for a step: tool + a coarse operation head. Two calls to
 *  the same tool with different operations are DIFFERENT tokens (so repeats with
 *  distinct work are kept distinct); two calls with the same operation share a
 *  token (so a genuine repeat aligns). */
export function stepSignature(step: Pick<ProcedureStep, "tool" | "operation">): string {
  // Coarse operation head: the leading verb + object (first two words), so
  // "bun install" and "bun install --frozen-lockfile" align (a flag variant is
  // the same step) while "bun install" and "bun test" do not.
  const opHead = step.operation.split(" ").slice(0, 2).join(" ");
  return `${step.tool}${opHead}`;
}

/** One aligned backbone position: the shared step signature and a representative
 *  step (from the newest trace that had it) for display. */
export interface BackbonePosition {
  tool: string;
  operation: string;
  /** How many of the aligned traces agreed on this position. */
  support: number;
}

const MAX_BACKBONE_STEPS = 40;

/**
 * The majority backbone of several ordered procedures, by SEQUENCE ALIGNMENT
 * (progressive pairwise LCS over step signatures). Repeated positions are
 * preserved: a signature that recurs in a trace can be matched multiple times,
 * so a two-`bash` run keeps two positions. A position survives when a MAJORITY
 * of the input traces support it. Deterministic; traces expected oldest ->
 * newest so the representative operation is the most recent phrasing. Pure.
 */
export function alignProcedures(
  traces: readonly (readonly ProcedureStep[])[],
): BackbonePosition[] {
  const present = traces.filter((t) => t.length > 0);
  if (present.length === 0) return [];
  const majority = Math.floor(present.length / 2) + 1;

  // Progressive alignment: fold each trace into an accumulator of aligned
  // COLUMNS. Each column tracks its support count and the newest representative
  // (tool, operation). LCS-align the accumulator's signature spine against the
  // next trace; matched columns gain support + refresh their representative,
  // unmatched trace steps are inserted as new columns (support 1) in order.
  interface Column {
    sig: string;
    tool: string;
    operation: string;
    support: number;
  }
  let columns: Column[] = present[0]!.map((s) => ({
    sig: stepSignature(s),
    tool: s.tool,
    operation: s.operation,
    support: 1,
  }));

  for (let t = 1; t < present.length; t++) {
    const trace = present[t]!;
    const traceSigs = trace.map(stepSignature);
    const colSigs = columns.map((c) => c.sig);
    const matched = lcsMatch(colSigs, traceSigs);
    // matched.colToTrace[i] = j means column i aligns to trace step j.
    const next: Column[] = [];
    let ti = 0;
    for (let ci = 0; ci < columns.length; ci++) {
      const j = matched.colToTrace[ci];
      if (j !== undefined) {
        // Emit any UNMATCHED trace steps that come before this match, in order.
        while (ti < j) {
          const s = trace[ti]!;
          next.push({ sig: traceSigs[ti]!, tool: s.tool, operation: s.operation, support: 1 });
          ti++;
        }
        // Emit the matched column, with refreshed (newest) representative.
        const s = trace[j]!;
        next.push({ ...columns[ci]!, tool: s.tool, operation: s.operation, support: columns[ci]!.support + 1 });
        ti = j + 1;
      } else {
        // Column had no match in this trace: carry it forward unchanged.
        next.push(columns[ci]!);
      }
    }
    // Trailing unmatched trace steps.
    while (ti < trace.length) {
      const s = trace[ti]!;
      next.push({ sig: traceSigs[ti]!, tool: s.tool, operation: s.operation, support: 1 });
      ti++;
    }
    columns = next;
  }

  return columns
    .filter((c) => c.support >= majority)
    .slice(0, MAX_BACKBONE_STEPS)
    .map((c) => ({ tool: c.tool, operation: c.operation, support: c.support }));
}

/**
 * LCS alignment of two signature sequences. Returns, for each index in `a`, the
 * matched index in `b` (or undefined). Preserves order and matches repeated
 * signatures greedily by position (a repeated token can match multiple times).
 */
function lcsMatch(a: readonly string[], b: readonly string[]): { colToTrace: (number | undefined)[] } {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const colToTrace: (number | undefined)[] = new Array(n).fill(undefined);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      colToTrace[i] = j;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return { colToTrace };
}
