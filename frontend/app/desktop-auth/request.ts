import { desktopAuthClient } from "@/lib/desktop-auth-client";

export type DesktopAuthRequest = {
  query: Record<string, string>;
  url: string;
};

export function desktopAuthRequest(value: string): DesktopAuthRequest | null {
  const url = new URL(value);
  const query = Object.fromEntries(url.searchParams);
  if (url.hash || url.searchParams.size !== 4
    || url.searchParams.getAll("client_id").length !== 1 || query.client_id !== "electron"
    || url.searchParams.getAll("state").length !== 1 || !/^[A-Za-z0-9]{16}$/.test(query.state ?? "")
    || url.searchParams.getAll("code_challenge").length !== 1 || !/^[A-Za-z0-9_-]{43}=?$/.test(query.code_challenge ?? "")
    || url.searchParams.getAll("code_challenge_method").length !== 1 || query.code_challenge_method !== "S256") return null;
  return { query, url: `${url.pathname}${url.search}` };
}

/** OAuth must land back on this page, which is the only one polling for the desktop redirect. */
export async function startDesktopGoogleSignIn(
  request: DesktopAuthRequest,
  social: (input: { provider: "google"; callbackURL: string; fetchOptions: { query: Record<string, string> } }) => Promise<{ error: unknown }>
    = (input) => desktopAuthClient.signIn.social(input),
): Promise<void> {
  const result = await social({ provider: "google", callbackURL: request.url, fetchOptions: { query: request.query } });
  if (result.error) throw new Error("Could not start Google sign-in.");
}

export function restartElectronRedirect(
  previous: ReturnType<typeof setInterval> | null,
  start: () => ReturnType<typeof setInterval> = () => desktopAuthClient.ensureElectronRedirect(),
  stop: (timer: ReturnType<typeof setInterval>) => void = clearInterval,
): ReturnType<typeof setInterval> {
  if (previous) stop(previous);
  return start();
}
