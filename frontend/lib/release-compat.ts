export const USEAGENT_API_COMPAT = "run-events-v1";

const CLIENT_COMMIT = process.env.NEXT_PUBLIC_USEAGENT_RELEASE_COMMIT?.trim().toLowerCase() || "dev";
export const CLIENT_RELEASE_FINGERPRINT = `${USEAGENT_API_COMPAT}:${CLIENT_COMMIT}`;

const RELOAD_MARKER = "skynet.release.reload";

export class FrontendReleaseMismatchError extends Error {
  constructor(readonly serverFingerprint: string) {
    super("Frontend was updated. Reload before retrying this action.");
    this.name = "FrontendReleaseMismatchError";
  }
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function isApiPath(path: string): boolean {
  return path.startsWith("/api/");
}

function isMutating(method: string | undefined): boolean {
  return !["GET", "HEAD"].includes((method ?? "GET").toUpperCase());
}

export function withClientReleaseHeader(path: string, init?: RequestInit): RequestInit | undefined {
  if (!isBrowser() || !isApiPath(path)) return init;
  const headers = new Headers(init?.headers);
  headers.set("x-useagent-client-release", CLIENT_RELEASE_FINGERPRINT);
  return { ...init, headers };
}

export function scheduleReleaseReload(): void {
  if (!isBrowser()) return;
  try {
    if (window.sessionStorage.getItem(RELOAD_MARKER) === CLIENT_RELEASE_FINGERPRINT) return;
    window.sessionStorage.setItem(RELOAD_MARKER, CLIENT_RELEASE_FINGERPRINT);
  } catch {
    // Storage can be unavailable in hardened browsers; the reload is still safe.
  }
  window.setTimeout(() => window.location.reload(), 0);
}

export function handleReleaseMismatch(response: Response, init?: RequestInit): void {
  const serverFingerprint =
    response.headers.get("x-useagent-release-fingerprint") ??
    response.headers.get("x-skynet-release-fingerprint");
  if (!serverFingerprint || serverFingerprint === CLIENT_RELEASE_FINGERPRINT) return;
  if (serverFingerprint.endsWith(":dev")) return;
  scheduleReleaseReload();
  if (isMutating(init?.method)) throw new FrontendReleaseMismatchError(serverFingerprint);
}
