import type {
  FinishedWorkObligationRecord,
  FinishedWorkReceiptRecord,
} from "./finished-work-repo";

export type FinishedWorkNotRequiredReason =
  | "read_only_answer"
  | "repository_change"
  | "no_material_output_observed";

export type FinishedWorkDecision =
  | { readonly status: "not_required"; readonly reason: FinishedWorkNotRequiredReason }
  | { readonly status: "ready"; readonly receipts: readonly FinishedWorkReceiptRecord[] }
  | { readonly status: "blocked"; readonly obligations: readonly FinishedWorkObligationRecord[] }
  | {
      readonly status: "failed";
      readonly obligations: readonly FinishedWorkObligationRecord[];
      readonly failureCodes: readonly string[];
    };

export function evaluateFinishedWork(input: {
  readonly obligations: readonly FinishedWorkObligationRecord[];
  readonly receipts: readonly FinishedWorkReceiptRecord[];
}): FinishedWorkDecision {
  const failed = input.obligations.filter((obligation) => obligation.state === "failed");
  if (failed.length > 0) {
    return {
      status: "failed",
      obligations: failed,
      failureCodes: [...new Set(failed.map((obligation) => obligation.failureCode ?? "finished_work_failed"))].sort(),
    };
  }
  const open = input.obligations.filter((obligation) => obligation.state === "open");
  if (open.length > 0) return { status: "blocked", obligations: open };
  if (input.obligations.length > 0) return { status: "ready", receipts: input.receipts };
  if (input.receipts.some((receipt) => receipt.kind === "read_only_answer")) {
    return { status: "not_required", reason: "read_only_answer" };
  }
  if (input.receipts.some((receipt) => receipt.kind === "repository_changed")) {
    return { status: "not_required", reason: "repository_change" };
  }
  return { status: "not_required", reason: "no_material_output_observed" };
}

export function finishedWorkFailureSummary(decision: Extract<FinishedWorkDecision, { status: "blocked" | "failed" }>): string {
  if (decision.status === "blocked") {
    return "Completion verification failed: required finished work was not produced. Retry the task or inspect the run details.";
  }
  return `Completion verification failed: required finished work could not be produced (${decision.failureCodes.join(", ")}).`;
}
