import { type SandboxCredentialCode, SandboxCredentialError, sandboxCredentialStatus } from "@useagent/sandbox-contract";
import { BOX_API_URL, type BoxFetch } from "./provider";

function codeForStatus(status: number): SandboxCredentialCode | null {
  if (status === 401) return "authentication_failed";
  if (status === 402 || status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return null;
}

const fail = (code: SandboxCredentialCode): SandboxCredentialError => new SandboxCredentialError(code, sandboxCredentialStatus(code));

/**
 * Prove a Box key works (GET /me) and, when a snapshot is named, that the
 * account can see it (GET /snapshots). Never creates a box.
 */
export async function validateBoxConnection(
  input: { readonly apiKey: string; readonly snapshotName?: string },
  deps: { readonly fetchImpl?: BoxFetch; readonly apiUrl?: string } = {},
): Promise<void> {
  const fetchImpl: BoxFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const apiUrl = (deps.apiUrl ?? BOX_API_URL).replace(/\/+$/, "");
  const call = async (path: string): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw fail("provider_unavailable");
    }
    if (!response.ok) throw fail(codeForStatus(response.status) ?? "provider_unavailable");
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw fail("provider_unavailable");
    }
  };
  await call("/me");
  const snapshotName = input.snapshotName?.trim();
  if (!snapshotName) return;
  const payload = await call("/snapshots");
  const snapshots = Array.isArray(payload.snapshots) ? (payload.snapshots as Record<string, unknown>[]) : [];
  const found = snapshots.some((snapshot) => snapshot.name === snapshotName || snapshot.id === snapshotName);
  if (!found) throw fail("snapshot_not_found");
}
