export interface AdmissionOwnerState {
  readonly open: boolean;
  readonly operationId: string;
}

export interface AdmissionOwnerChange {
  readonly open: boolean;
  readonly operationId: string;
}

export class RunAdmissionOwnershipError extends Error {
  readonly code = "run_admission_operation_conflict";

  constructor(current: AdmissionOwnerState, requestedOperationId: string) {
    super(
      `Run admission is owned by ${current.operationId}; ${requestedOperationId} cannot replace it`,
    );
    this.name = "RunAdmissionOwnershipError";
  }
}

export function resolveAdmissionChange(
  current: AdmissionOwnerState,
  change: AdmissionOwnerChange,
): "apply" | "unchanged" {
  if (current.open) return change.open ? "unchanged" : "apply";
  if (current.operationId !== change.operationId) {
    throw new RunAdmissionOwnershipError(current, change.operationId);
  }
  return current.open === change.open ? "unchanged" : "apply";
}
