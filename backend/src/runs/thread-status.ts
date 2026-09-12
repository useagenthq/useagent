import type { AdmissionState, QueueReason, RunStatus } from "../db/schema";

export const PRODUCT_THREAD_STATUSES = [
  "queued",
  "waiting",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ProductThreadStatus = (typeof PRODUCT_THREAD_STATUSES)[number];

const CAPACITY_WAIT_REASONS = new Set<QueueReason>([
  "global_limit",
  "org_limit",
  "provider_capacity",
  "lease_expired",
]);

export function projectProductThreadStatus(input: {
  readonly runStatus: RunStatus;
  readonly admissionState: AdmissionState | null;
  readonly queueReason: QueueReason | null;
  readonly cancelIntent: boolean;
}): ProductThreadStatus {
  if (input.cancelIntent || input.admissionState === "canceled") return "cancelled";
  if (input.runStatus === "completed") return "completed";
  if (input.runStatus === "failed") return "failed";
  if (input.runStatus === "running" || input.admissionState === "running") return "running";
  if (
    input.runStatus === "queued" &&
    input.admissionState === "queued" &&
    input.queueReason !== null &&
    CAPACITY_WAIT_REASONS.has(input.queueReason)
  ) return "waiting";
  return "queued";
}
