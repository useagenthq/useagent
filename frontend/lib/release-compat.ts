export const USEAGENT_API_COMPAT = "run-events-v1";

const CLIENT_COMMIT = process.env.NEXT_PUBLIC_USEAGENT_RELEASE_COMMIT?.trim().toLowerCase() || "dev";
export const CLIENT_RELEASE_FINGERPRINT = `${USEAGENT_API_COMPAT}:${CLIENT_COMMIT}`;

const RELOAD_MARKER = "useagent.release.reload";

export class FrontendReleaseMismatchError extends Error {
  constructor(
    readonly serverFingerprint: string,
    /** True when this tab already reloaded for this release and still differs:
     *  the page being served is older than the server, so another reload
     *  changes nothing until the deployment finishes. */
    readonly reloadedAlready = false,
  ) {
    super(
      reloadedAlready
        ? "This page and the server are still on different releases, and reloading once did not change that. Wait a minute, then reload and try again."
        : "Frontend was updated. Reload before retrying this action.",
    );
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

/** Whether this page load already queued its reload (the marker alone cannot
 *  tell a queued reload from one that ran in an earlier page load). */
let reloadQueuedThisLoad = false;

/** Tests run many page loads in one module instance. */
export function resetReleaseReloadStateForTest(): void {
  reloadQueuedThisLoad = false;
}

export type ReleaseReloadOutcome = "scheduled" | "pending" | "exhausted";

/** Schedule one reload per client release. "pending" means this page load
 *  already queued it; "exhausted" means an earlier page load reloaded for this
 *  release and the server still differs, so the served bundle is behind. */
export function scheduleReleaseReload(): ReleaseReloadOutcome {
  if (!isBrowser()) return "exhausted";
  if (reloadQueuedThisLoad) return "pending";
  try {
    if (window.sessionStorage.getItem(RELOAD_MARKER) === CLIENT_RELEASE_FINGERPRINT) return "exhausted";
    window.sessionStorage.setItem(RELOAD_MARKER, CLIENT_RELEASE_FINGERPRINT);
  } catch {
    // Storage can be unavailable in hardened browsers; the reload is still safe.
  }
  reloadQueuedThisLoad = true;
  window.setTimeout(() => window.location.reload(), 0);
  return "scheduled";
}

export function handleReleaseMismatch(response: Response, init?: RequestInit): void {
  const serverFingerprint = response.headers.get("x-useagent-release-fingerprint");
  if (!serverFingerprint || serverFingerprint === CLIENT_RELEASE_FINGERPRINT) return;
  if (serverFingerprint.endsWith(":dev")) return;
  const outcome = scheduleReleaseReload();
  if (isMutating(init?.method)) throw new FrontendReleaseMismatchError(serverFingerprint, outcome === "exhausted");
}
