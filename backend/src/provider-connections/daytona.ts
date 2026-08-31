import {
  Daytona,
  DaytonaAuthenticationError,
  DaytonaForbiddenError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaServiceUnavailableError,
  DaytonaTimeoutError,
} from "@daytona/sdk";

export type DaytonaConnectionValidationCode =
  | "authentication_failed"
  | "forbidden"
  | "snapshot_not_found"
  | "snapshot_not_active"
  | "rate_limited"
  | "provider_unavailable";

export class DaytonaConnectionValidationError extends Error {
  constructor(readonly code: DaytonaConnectionValidationCode) {
    super(code);
    this.name = "DaytonaConnectionValidationError";
  }
}

export interface DaytonaConnectionValidatorClient {
  readonly snapshot: {
    get(name: string): Promise<{ readonly name: string; readonly state: string }>;
  };
  readonly [Symbol.asyncDispose]?: () => Promise<void>;
}

function normalizeDaytonaValidationError(error: unknown): unknown {
  if (error instanceof DaytonaConnectionValidationError) return error;
  if (error instanceof DaytonaAuthenticationError) {
    return new DaytonaConnectionValidationError("authentication_failed");
  }
  if (error instanceof DaytonaForbiddenError) {
    return new DaytonaConnectionValidationError("forbidden");
  }
  if (error instanceof DaytonaNotFoundError) {
    return new DaytonaConnectionValidationError("snapshot_not_found");
  }
  if (error instanceof DaytonaRateLimitError) {
    return new DaytonaConnectionValidationError("rate_limited");
  }
  if (error instanceof DaytonaTimeoutError || error instanceof DaytonaServiceUnavailableError) {
    return new DaytonaConnectionValidationError("provider_unavailable");
  }
  return error;
}

export async function validateDaytonaConnection(
  input: { readonly apiKey: string; readonly snapshotName: string },
  deps: {
    readonly createClient?: (apiKey: string) => DaytonaConnectionValidatorClient;
  } = {},
): Promise<void> {
  const createClient = deps.createClient ?? ((apiKey: string) => new Daytona({
    apiKey,
    apiUrl: process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api",
    target: process.env.DAYTONA_TARGET?.trim() || "us",
    requestTimeoutMs: 15_000,
    // Snapshot validation never observes sandbox state. Avoid opening the SDK's
    // WebSocket event dispatcher for this one bounded metadata lookup.
    useDeprecatedPolling: true,
  }));
  const client = createClient(input.apiKey);
  let validationError: unknown = null;
  try {
    const snapshot = await client.snapshot.get(input.snapshotName);
    if (snapshot.name !== input.snapshotName || snapshot.state !== "active") {
      throw new DaytonaConnectionValidationError("snapshot_not_active");
    }
  } catch (error) {
    validationError = normalizeDaytonaValidationError(error);
  }
  try {
    await client[Symbol.asyncDispose]?.();
  } catch {
    console.warn("[provider-connections] Daytona validation client cleanup failed");
    validationError ??= new DaytonaConnectionValidationError("provider_unavailable");
  }
  if (validationError) throw validationError;
}

export function daytonaValidationHttpStatus(
  code: DaytonaConnectionValidationCode,
): 401 | 403 | 404 | 409 | 429 | 503 {
  switch (code) {
    case "authentication_failed":
      return 401;
    case "forbidden":
      return 403;
    case "snapshot_not_found":
      return 404;
    case "snapshot_not_active":
      return 409;
    case "rate_limited":
      return 429;
    case "provider_unavailable":
      return 503;
  }
}
