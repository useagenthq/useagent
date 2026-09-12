import { BOX_API_URL, type BoxFetch } from "../sandboxes/box-provider";

export type BoxConnectionValidationCode =
  | "authentication_failed"
  | "forbidden"
  | "snapshot_not_found"
  | "rate_limited"
  | "provider_unavailable";

export class BoxConnectionValidationError extends Error {
  constructor(readonly code: BoxConnectionValidationCode) {
    super(code);
    this.name = "BoxConnectionValidationError";
  }
}

function codeForStatus(status: number): BoxConnectionValidationCode | null {
  if (status === 401) return "authentication_failed";
  if (status === 402 || status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return null;
}

/**
 * Prove a Box key works (GET /me) and, when a snapshot is named, that the
 * account can see it (GET /snapshots). Never creates a box.
 */
export async function validateBoxConnection(
  input: { readonly apiKey: string; readonly snapshotName?: string },
  deps: { readonly fetchImpl?: BoxFetch; readonly apiUrl?: string } = {},
): Promise<void> {
  const fetchImpl: BoxFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const apiUrl = (deps.apiUrl ?? process.env.BOX_API_URL?.trim() ?? BOX_API_URL).replace(/\/+$/, "");
  const call = async (path: string): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BoxConnectionValidationError("provider_unavailable");
    }
    if (!response.ok) {
      throw new BoxConnectionValidationError(codeForStatus(response.status) ?? "provider_unavailable");
    }
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new BoxConnectionValidationError("provider_unavailable");
    }
  };
  await call("/me");
  const snapshotName = input.snapshotName?.trim();
  if (!snapshotName) return;
  const payload = await call("/snapshots");
  const snapshots = Array.isArray(payload.snapshots) ? (payload.snapshots as Record<string, unknown>[]) : [];
  const found = snapshots.some((snapshot) => snapshot.name === snapshotName || snapshot.id === snapshotName);
  if (!found) throw new BoxConnectionValidationError("snapshot_not_found");
}

export function boxValidationHttpStatus(code: BoxConnectionValidationCode): 400 | 401 | 403 | 404 | 429 | 503 {
  switch (code) {
    case "authentication_failed":
      return 401;
    case "forbidden":
      return 403;
    case "snapshot_not_found":
      return 404;
    case "rate_limited":
      return 429;
    case "provider_unavailable":
      return 503;
  }
}
