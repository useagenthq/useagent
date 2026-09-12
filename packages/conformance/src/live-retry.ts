export const LIVE_CONFORMANCE_ATTEMPTS = 2;

export interface LiveRetryTurnEvidence {
  readonly status: string;
  readonly summary: string;
  readonly errors: readonly string[];
}

export interface LiveRetryCaseEvidence {
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly turns: readonly LiveRetryTurnEvidence[];
}

const RETRYABLE_TERMINAL_SUMMARIES = new Set([
  "error: Selected model is at capacity. Please try a different model.",
  "error: 2: [unknown] missing EndStreamResponse",
  "error: provider completed without assistant output",
]);

function isExpectedTransientValidationError(error: string): boolean {
  return error === "terminal status was failed" ||
    error === "summary did not include the case token" ||
    error === "not all turns completed" ||
    error.startsWith("summary did not match /") ||
    /^missing available \S+ artifact$/.test(error) ||
    /^required tool .+ unavailable \(no successful or failed attempt evidence\)$/.test(error);
}

export function isRetryableLiveConformanceFailure(
  evidence: LiveRetryCaseEvidence,
): boolean {
  if (evidence.passed || evidence.turns.length === 0) return false;
  const failedTurns = evidence.turns.filter((turn) => turn.status === "failed");
  const failedTurn = failedTurns[0];
  if (
    failedTurns.length !== 1 ||
    failedTurn !== evidence.turns.at(-1) ||
    !failedTurn ||
    !RETRYABLE_TERMINAL_SUMMARIES.has(failedTurn.summary)
  ) {
    return false;
  }
  if (evidence.turns.slice(0, -1).some(
    (turn) => turn.status !== "completed" || turn.errors.length > 0,
  )) {
    return false;
  }
  return failedTurn.errors.length > 0 &&
    failedTurn.errors.every(isExpectedTransientValidationError) &&
    evidence.errors.length > 0 &&
    evidence.errors.every(isExpectedTransientValidationError);
}

export async function executeLiveConformanceWithTransientRetry<
  T extends LiveRetryCaseEvidence,
>(options: {
  readonly execute: (attempt: number) => Promise<T>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly onRetry?: (failedAttempt: T, attempt: number) => void;
}): Promise<{ readonly result: T; readonly attempts: readonly T[] }> {
  const attempts: T[] = [];
  for (let attempt = 1; attempt <= LIVE_CONFORMANCE_ATTEMPTS; attempt += 1) {
    const result = await options.execute(attempt);
    attempts.push(result);
    if (
      result.passed ||
      attempt === LIVE_CONFORMANCE_ATTEMPTS ||
      !isRetryableLiveConformanceFailure(result)
    ) {
      return { result, attempts };
    }
    options.onRetry?.(result, attempt);
    await options.sleep(attempt * 2_000);
  }
  throw new Error("live conformance retry loop exhausted without a result");
}
