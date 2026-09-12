import {
  Daytona,
  DaytonaAuthenticationError,
  DaytonaForbiddenError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaServiceUnavailableError,
  DaytonaTimeoutError,
} from "@daytona/sdk";
import { type SandboxCredentialCode, SandboxCredentialError, sandboxCredentialStatus } from "@useagent/sandbox-contract";

export interface DaytonaConnectionValidatorClient {
  readonly snapshot: {
    get(name: string): Promise<{ readonly name: string; readonly state: string }>;
  };
  readonly [Symbol.asyncDispose]?: () => Promise<void>;
}

const fail = (code: SandboxCredentialCode, message?: string): SandboxCredentialError =>
  new SandboxCredentialError(code, sandboxCredentialStatus(code), message);

function normalizeDaytonaValidationError(error: unknown): unknown {
  if (error instanceof SandboxCredentialError) return error;
  if (error instanceof DaytonaAuthenticationError) return fail("authentication_failed");
  if (error instanceof DaytonaForbiddenError) return fail("forbidden");
  if (error instanceof DaytonaNotFoundError) return fail("snapshot_not_found");
  if (error instanceof DaytonaRateLimitError) return fail("rate_limited");
  if (error instanceof DaytonaTimeoutError || error instanceof DaytonaServiceUnavailableError) {
    return fail("provider_unavailable");
  }
  return error;
}

/**
 * Prove a Daytona key works and that the named snapshot is the one it can
 * run from (exact name, active). Never creates a sandbox.
 */
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
      // A snapshot that is not active cannot start a sandbox; the shared codes
      // treat it like a missing one.
      throw fail("snapshot_not_found", "Daytona snapshot is not active");
    }
  } catch (error) {
    validationError = normalizeDaytonaValidationError(error);
  }
  try {
    await client[Symbol.asyncDispose]?.();
  } catch {
    console.warn("[sandbox-daytona] validation client cleanup failed");
    validationError ??= fail("provider_unavailable");
  }
  if (validationError) throw validationError;
}
