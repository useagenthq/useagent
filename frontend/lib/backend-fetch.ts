/**
 * Isomorphic fetch to the useAgent backend (live on :3201).
 *
 * - Server: hit the backend origin directly (the Next `/api/*` rewrite only
 *   applies to browser requests) and forward the incoming request's `Cookie`
 *   header so the backend resolves the signed-in user's session/org during SSR
 *   instead of falling back to the dev org.
 * - Client: use a relative `/api/...` path so the rewrite proxies it, with
 *   `credentials:"include"` so the browser attaches the same-origin auth cookie.
 *
 * `next/headers` is imported lazily inside the server branch so this module is
 * safe to pull into the client bundle (the per-feature api layers that use it
 * are shared by client components).
 */
import { handleReleaseMismatch, withClientReleaseHeader } from "./release-compat";

const API_ORIGIN = process.env.USEAGENT_API_ORIGIN ?? "http://localhost:3201";

export async function backendFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (typeof window === "undefined") {
    const { cookies } = await import("next/headers");
    const cookieHeader = (await cookies()).toString();
    const headers = new Headers(init?.headers);
    if (cookieHeader) headers.set("cookie", cookieHeader);
    return fetch(`${API_ORIGIN}${path}`, { ...init, headers });
  }
  const browserInit = withClientReleaseHeader(path, init);
  const response = await fetch(path, { ...browserInit, credentials: "include" });
  handleReleaseMismatch(response, browserInit);
  return response;
}
