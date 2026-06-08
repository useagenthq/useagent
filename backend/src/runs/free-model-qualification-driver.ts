import type { ApiRun } from "@useagent/agent-client/wire";
import type { RunCommandInput, RunCommandOutcome } from "../commands/types";
import type { FreeModelProbeErrorCode } from "../db/schema";
import { MODEL_QUALIFICATION_RUN_ORIGIN } from "./origin";

export const FREE_MODEL_QUALIFICATION_ORIGIN = MODEL_QUALIFICATION_RUN_ORIGIN;
export const FREE_MODEL_QUALIFICATION_PRIORITY = -100;
export const FREE_MODEL_QUALIFICATION_MARKER = "USEAGENT_MODEL_QUALIFICATION_OK";

export interface FreeModelQualificationRequest {
  readonly modelId: string;
  readonly claimToken: string;
}

export type FreeModelQualificationResult =
  | {
      readonly classification: "success";
      readonly latencyMs: number;
      readonly httpStatus: 200;
      readonly errorCode: null;
    }
  | {
      readonly classification: "model_failure" | "system_failure";
      readonly latencyMs: number;
      readonly httpStatus: number | null;
      readonly errorCode: FreeModelProbeErrorCode;
    };

export interface FreeModelQualificationDriver {
  qualify(request: FreeModelQualificationRequest): Promise<FreeModelQualificationResult>;
}

type InternalQualificationCommand = RunCommandInput & {
  readonly origin: typeof FREE_MODEL_QUALIFICATION_ORIGIN;
  readonly priority: number;
};

export interface InternalQualificationRunServices {
  readonly accept: (input: InternalQualificationCommand) => Promise<RunCommandOutcome>;
  readonly pump: (threadId: string) => Promise<string | null>;
  readonly read: (orgId: string, runId: string) => Promise<ApiRun | null>;
  readonly cancel: (orgId: string, runId: string) => Promise<void>;
  readonly admission?: () => Promise<{ readonly open: boolean }>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly nowMs?: () => number;
}

export interface InternalQualificationRunDriverOptions {
  readonly orgId: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

const PROMPT = [
  "This is an automated model qualification run.",
  `Use the shell tool to execute: printf ${FREE_MODEL_QUALIFICATION_MARKER}.`,
  `After the tool succeeds, reply with exactly ${FREE_MODEL_QUALIFICATION_MARKER}.`,
].join("\n");

function statusFromSummary(summary: string): number | null {
  const match = summary.match(/\b([1-5][0-9]{2})\b/);
  return match ? Number(match[1]) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function qualificationShellSucceeded(steps: readonly ApiRun["steps"][number][]): boolean {
  return steps.some((step) => {
    if (step.kind !== "command" || !step.code_json) return false;
    let code: Record<string, unknown> | null = null;
    try {
      code = record(JSON.parse(step.code_json));
    } catch {
      return false;
    }
    const input = record(code?.input);
    const command = typeof input?.command === "string"
      ? input.command
      : typeof code?.command === "string"
        ? code.command
        : "";
    const output = typeof code?.output === "string" ? code.output : "";
    const failed = code?.error === true || code?.status === "failed";
    return !failed &&
      command.includes("printf") &&
      command.includes(FREE_MODEL_QUALIFICATION_MARKER) &&
      output.includes(FREE_MODEL_QUALIFICATION_MARKER);
  });
}

class QualificationDeadlineError extends Error {}

async function withinDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new QualificationDeadlineError("qualification deadline elapsed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new QualificationDeadlineError("qualification deadline elapsed")),
          remainingMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function classifyFailedQualificationRun(
  summary: string | null,
  latencyMs: number,
): Exclude<FreeModelQualificationResult, { classification: "success" }> {
  const text = (summary ?? "").toLowerCase();
  const httpStatus = statusFromSummary(text);
  if (
    text.includes("hosted app") ||
    text.includes("application restriction") ||
    text.includes("not allowed for this app") ||
    text.includes("application is not authorized")
  ) {
    return { classification: "model_failure", latencyMs, httpStatus, errorCode: "hosted_app_restricted" };
  }
  if (httpStatus === 429) {
    return { classification: "system_failure", latencyMs, httpStatus, errorCode: "rate_limited" };
  }
  if (httpStatus === 401 || httpStatus === 402) {
    return { classification: "system_failure", latencyMs, httpStatus, errorCode: "authentication_failed" };
  }
  if (httpStatus !== null && httpStatus >= 500) {
    return { classification: "system_failure", latencyMs, httpStatus, errorCode: "provider_capacity" };
  }
  if (
    text.includes("api key") ||
    text.includes("authentication") ||
    text.includes("unauthorized") ||
    text.includes("insufficient credit")
  ) {
    return { classification: "system_failure", latencyMs, httpStatus, errorCode: "authentication_failed" };
  }
  if (
    text.includes("sandbox") ||
    text.includes("provision") ||
    text.includes("provider capacity") ||
    text.includes("no first activity")
  ) {
    return { classification: "system_failure", latencyMs, httpStatus, errorCode: "provider_capacity" };
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return { classification: "system_failure", latencyMs, httpStatus, errorCode: "timeout" };
  }
  if (text.includes("rate limit")) {
    return { classification: "system_failure", latencyMs, httpStatus, errorCode: "rate_limited" };
  }
  if (text.includes("tool")) {
    return { classification: "model_failure", latencyMs, httpStatus, errorCode: "tool_call_failed" };
  }
  return { classification: "model_failure", latencyMs, httpStatus, errorCode: "unknown" };
}

/**
 * Create a real low-priority OpenCode run and require both a shell-tool step and
 * the exact final marker. Internal origins are excluded from product thread
 * lists and memory capture by the existing visibility/finalization contracts.
 */
export function createInternalOpenCodeQualificationDriver(
  options: InternalQualificationRunDriverOptions,
  services: InternalQualificationRunServices,
): FreeModelQualificationDriver {
  if (!options.orgId.trim()) throw new Error("free_model_qualifier_org_missing");
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 1_000;
  const sleep = services.sleep ?? ((ms: number) => Bun.sleep(ms));
  const nowMs = services.nowMs ?? Date.now;

  return {
    async qualify(request) {
      const startedAt = nowMs();
      const deadlineAt = Date.now() + timeoutMs;
      const runId = crypto.randomUUID();
      const cancelBestEffort = (acceptedRunId: string): void => {
        void services.cancel(options.orgId, acceptedRunId).catch(() => {});
      };
      let accepted: RunCommandOutcome;
      try {
        accepted = await withinDeadline(() => services.accept({
        idempotencyKey: `free-model-qualification:${request.claimToken}`,
        orgId: options.orgId,
        actorId: null,
        acceptedModelPolicy: "persisted",
        origin: FREE_MODEL_QUALIFICATION_ORIGIN,
        priority: FREE_MODEL_QUALIFICATION_PRIORITY,
        run: {
          id: runId,
          prompt: PROMPT,
          model: request.modelId,
          engine: "opencode",
          parentRunId: null,
          threadId: runId,
          repos: [],
          resolvedResources: [],
          attachmentIds: [],
          memoryScope: "org",
          skillId: null,
          skillVersion: null,
          skillContentHash: null,
          commandName: null,
          commandProvider: null,
          commandSessionId: null,
          commandCatalogRevision: null,
        },
        }), deadlineAt);
      } catch (error) {
        return {
          classification: "system_failure",
          latencyMs: nowMs() - startedAt,
          httpStatus: null,
          errorCode: error instanceof QualificationDeadlineError ? "timeout" : "transport_error",
        };
      }
      if (accepted.status === "conflict") {
        return {
          classification: "system_failure",
          latencyMs: nowMs() - startedAt,
          httpStatus: null,
          errorCode: "policy_rejected",
        };
      }
      const acceptedRunId = accepted.runId;
      const admissionOpen = async (): Promise<boolean> => {
        if (!services.admission) return true;
        return (await withinDeadline(services.admission, deadlineAt)).open;
      };
      try {
        if (!(await admissionOpen())) {
          cancelBestEffort(acceptedRunId);
          return {
            classification: "system_failure",
            latencyMs: nowMs() - startedAt,
            httpStatus: null,
            errorCode: "policy_rejected",
          };
        }
      } catch (error) {
        cancelBestEffort(acceptedRunId);
        return {
          classification: "system_failure",
          latencyMs: nowMs() - startedAt,
          httpStatus: null,
          errorCode: error instanceof QualificationDeadlineError ? "timeout" : "transport_error",
        };
      }
      if (accepted.status === "created") {
        try {
          await withinDeadline(() => services.pump(acceptedRunId), deadlineAt);
        } catch (error) {
          cancelBestEffort(acceptedRunId);
          return {
            classification: "system_failure",
            latencyMs: nowMs() - startedAt,
            httpStatus: null,
            errorCode: error instanceof QualificationDeadlineError ? "timeout" : "transport_error",
          };
        }
      }

      while (nowMs() - startedAt < timeoutMs && Date.now() < deadlineAt) {
        try {
          if (!(await admissionOpen())) {
            cancelBestEffort(acceptedRunId);
            return {
              classification: "system_failure",
              latencyMs: nowMs() - startedAt,
              httpStatus: null,
              errorCode: "policy_rejected",
            };
          }
        } catch (error) {
          cancelBestEffort(acceptedRunId);
          return {
            classification: "system_failure",
            latencyMs: nowMs() - startedAt,
            httpStatus: null,
            errorCode: error instanceof QualificationDeadlineError ? "timeout" : "transport_error",
          };
        }
        let run: ApiRun | null;
        try {
          run = await withinDeadline(
            () => services.read(options.orgId, acceptedRunId),
            deadlineAt,
          );
        } catch (error) {
          if (error instanceof QualificationDeadlineError) {
            cancelBestEffort(acceptedRunId);
            return {
              classification: "system_failure",
              latencyMs: nowMs() - startedAt,
              httpStatus: null,
              errorCode: "timeout",
            };
          }
          try {
            await withinDeadline(() => sleep(pollMs), deadlineAt);
          } catch {
            cancelBestEffort(acceptedRunId);
            return {
              classification: "system_failure",
              latencyMs: nowMs() - startedAt,
              httpStatus: null,
              errorCode: "timeout",
            };
          }
          continue;
        }
        if (run?.status === "completed") {
          const hasShellTool = qualificationShellSucceeded(run.steps);
          const hasMarker = run.summary?.trim() === FREE_MODEL_QUALIFICATION_MARKER;
          if (hasShellTool && hasMarker) {
            return {
              classification: "success",
              latencyMs: nowMs() - startedAt,
              httpStatus: 200,
              errorCode: null,
            };
          }
          return {
            classification: "model_failure",
            latencyMs: nowMs() - startedAt,
            httpStatus: 200,
            errorCode: hasShellTool ? "invalid_response" : "tool_call_failed",
          };
        }
        if (run?.status === "failed") {
          return classifyFailedQualificationRun(run.summary, nowMs() - startedAt);
        }
        try {
          await withinDeadline(() => sleep(pollMs), deadlineAt);
        } catch {
          break;
        }
      }

      cancelBestEffort(acceptedRunId);
      return {
        classification: "system_failure",
        latencyMs: nowMs() - startedAt,
        httpStatus: null,
        errorCode: "timeout",
      };
    },
  };
}
