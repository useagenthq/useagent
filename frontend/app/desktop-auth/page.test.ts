import { expect, test } from "bun:test";
import { desktopAuthRequest, restartElectronRedirect, startDesktopGoogleSignIn } from "./request";
import { desktopAuthClient } from "@/lib/desktop-auth-client";

const valid = `https://plane.example/desktop-auth?client_id=electron&state=${"A".repeat(16)}&code_challenge=${"B".repeat(43)}&code_challenge_method=S256`;

test("desktop auth accepts only the official client request shape", () => {
  expect(typeof desktopAuthClient.ensureElectronRedirect).toBe("function");
  expect(typeof desktopAuthClient.electron.transferUser).toBe("function");
  expect(desktopAuthRequest(valid)?.query.client_id).toBe("electron");
  expect(desktopAuthRequest(valid)?.url.startsWith("/desktop-auth?")).toBe(true);
  expect(desktopAuthRequest(`${valid}&state=${"C".repeat(16)}`)).toBeNull();
  expect(desktopAuthRequest(`${valid}#unexpected`)).toBeNull();
  expect(desktopAuthRequest(valid.replace("S256", "plain"))).toBeNull();
  expect(desktopAuthRequest(valid.replace("client_id=electron", "client_id=attacker"))).toBeNull();
  // The Electron plugin encodes the challenge with base64url padding, so the 44-character form is the real one.
  expect(desktopAuthRequest(valid.replace("B".repeat(43), `${"B".repeat(43)}%3D`))?.query.code_challenge).toBe(`${"B".repeat(43)}=`);
  expect(desktopAuthRequest(valid.replace("B".repeat(43), `${"B".repeat(43)}%3D%3D`))).toBeNull();
  expect(desktopAuthRequest(valid.replace("B".repeat(43), `${"B".repeat(42)}%3D`))).toBeNull();
});

test("desktop approval replaces an expired redirect poll with a fresh bounded poll", () => {
  const expired = 1 as unknown as ReturnType<typeof setInterval>;
  const fresh = 2 as unknown as ReturnType<typeof setInterval>;
  const cleared: Array<ReturnType<typeof setInterval>> = [];
  expect(restartElectronRedirect(expired, () => fresh, timer => cleared.push(timer))).toBe(fresh);
  expect(cleared).toEqual([expired]);
});

test("desktop Google sign-in returns OAuth to the desktop-auth page that polls for the redirect", async () => {
  const request = desktopAuthRequest(valid)!;
  const calls: unknown[] = [];
  await startDesktopGoogleSignIn(request, async (input) => { calls.push(input); return { error: null }; });
  expect(calls).toEqual([{ provider: "google", callbackURL: request.url, fetchOptions: { query: request.query } }]);
  await expect(startDesktopGoogleSignIn(request, async () => ({ error: { message: "denied" } })))
    .rejects.toThrow("Could not start Google sign-in.");
});
