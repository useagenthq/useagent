import { afterEach, describe, expect, test } from "bun:test";
import {
  CLIENT_RELEASE_FINGERPRINT,
  FrontendReleaseMismatchError,
  handleReleaseMismatch,
  withClientReleaseHeader,
} from "./release-compat";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function installWindow() {
  let reloaded = false;
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { reload: () => { reloaded = true; } },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      setTimeout: (fn: () => void) => {
        fn();
        return 1;
      },
    },
  });
  return { reloaded: () => reloaded };
}

function responseWithFingerprint(fingerprint: string): Response {
  return new Response("{}", {
    headers: { "x-skynet-release-fingerprint": fingerprint },
  });
}

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
describe("release compatibility boundary", () => {
  test("adds the client release header to browser API requests only", () => {
    installWindow();
    const api = withClientReleaseHeader("/api/runs", { headers: { accept: "application/json" } });
    const nonApi = withClientReleaseHeader("/agent/new", { headers: { accept: "text/html" } });

    expect(new Headers(api?.headers).get("x-skynet-client-release")).toBe(
      CLIENT_RELEASE_FINGERPRINT,
    );
    expect(new Headers(nonApi?.headers).get("x-skynet-client-release")).toBeNull();
  });

  test("reloads a stale tab on safe requests", () => {
    const win = installWindow();
    handleReleaseMismatch(responseWithFingerprint("run-events-v1:ffffffff"), { method: "GET" });

    expect(win.reloaded()).toBe(true);
  });

  test("blocks stale-tab mutations after scheduling a controlled reload", () => {
    const win = installWindow();

    expect(() =>
      handleReleaseMismatch(responseWithFingerprint("run-events-v1:ffffffff"), {
        method: "POST",
      }),
    ).toThrow(FrontendReleaseMismatchError);
    expect(win.reloaded()).toBe(true);
  });
});
