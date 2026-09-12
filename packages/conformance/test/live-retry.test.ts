import { describe, expect, test } from "bun:test";
import {
  executeLiveConformanceWithTransientRetry,
  isRetryableLiveConformanceFailure,
  type LiveRetryCaseEvidence,
} from "../src/live-retry";

const emptyProjectionFailure: LiveRetryCaseEvidence = {
  passed: false,
  errors: [
    "terminal status was failed",
    "summary did not match /PARITY_ARTIFACT_OK/",
    "required tool artifact_publish unavailable (no successful or failed attempt evidence)",
    "missing available text/markdown artifact",
  ],
  turns: [{
    status: "failed",
    summary: "error: provider completed without assistant output",
    errors: [
      "terminal status was failed",
      "summary did not match /PARITY_ARTIFACT_OK/",
      "required tool artifact_publish unavailable (no successful or failed attempt evidence)",
      "missing available text/markdown artifact",
    ],
  }],
};

const capacityFailure: LiveRetryCaseEvidence = {
  passed: false,
  errors: [
    "terminal status was failed",
    "summary did not match /PARITY_MEMORY_RECALL_OK/",
    "required tool memory_search unavailable (no successful or failed attempt evidence)",
    "summary did not include the case token",
  ],
  turns: [
    { status: "completed", summary: "PARITY_MEMORY_SEEDED", errors: [] },
    {
      status: "failed",
      summary: "error: Selected model is at capacity. Please try a different model.",
      errors: [
        "terminal status was failed",
        "summary did not match /PARITY_MEMORY_RECALL_OK/",
        "required tool memory_search unavailable (no successful or failed attempt evidence)",
        "summary did not include the case token",
      ],
    },
  ],
};

const endStreamFailure: LiveRetryCaseEvidence = {
  passed: false,
  errors: [
    "terminal status was failed",
    "summary did not match /PARITY_REPO_OK/",
    "required tool github_clone_repository unavailable (no successful or failed attempt evidence)",
  ],
  turns: [{
    status: "failed",
    summary: "error: 2: [unknown] missing EndStreamResponse",
    errors: [
      "terminal status was failed",
      "summary did not match /PARITY_REPO_OK/",
      "required tool github_clone_repository unavailable (no successful or failed attempt evidence)",
    ],
  }],
};

describe("portable live conformance retry policy", () => {
  test("recognizes the bounded capacity and end-stream provider signatures", () => {
    expect(isRetryableLiveConformanceFailure(capacityFailure)).toBe(true);
    expect(isRetryableLiveConformanceFailure(endStreamFailure)).toBe(true);
  });

  test("retries one empty provider projection but not completed noncompliance", async () => {
    expect(isRetryableLiveConformanceFailure(emptyProjectionFailure)).toBe(true);
    expect(isRetryableLiveConformanceFailure({
      ...emptyProjectionFailure,
      turns: [{ ...emptyProjectionFailure.turns[0]!, status: "completed" }],
    })).toBe(false);

    let executions = 0;
    const passing = {
      passed: true,
      errors: [],
      turns: [{ status: "completed", summary: "PARITY_ARTIFACT_OK", errors: [] }],
    };
    const outcome = await executeLiveConformanceWithTransientRetry({
      execute: async () => ++executions === 1 ? emptyProjectionFailure : passing,
      sleep: async () => undefined,
    });
    expect(outcome.result).toBe(passing);
    expect(outcome.attempts).toHaveLength(2);
  });

  test("does not retry when a real tool or sandbox failure is present", () => {
    for (const realFailure of ["tool artifact_publish failed", "sandbox release failed"]) {
      expect(isRetryableLiveConformanceFailure({
        ...emptyProjectionFailure,
        errors: [...emptyProjectionFailure.errors, realFailure],
        turns: [{
          ...emptyProjectionFailure.turns[0]!,
          errors: [...emptyProjectionFailure.turns[0]!.errors, realFailure],
        }],
      })).toBe(false);
    }
  });

  test("fails closed after the one allowed retry repeats", async () => {
    let executions = 0;
    const outcome = await executeLiveConformanceWithTransientRetry({
      execute: async () => {
        executions += 1;
        return capacityFailure;
      },
      sleep: async () => undefined,
    });
    expect(outcome.result.passed).toBe(false);
    expect(outcome.attempts).toHaveLength(2);
    expect(executions).toBe(2);
  });
});
