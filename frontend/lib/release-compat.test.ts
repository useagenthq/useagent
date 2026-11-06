import { afterEach, describe, expect, test } from "bun:test";
import {
  CLIENT_RELEASE_FINGERPRINT,
  FrontendReleaseMismatchError,
  handleReleaseMismatch,
  resetReleaseReloadStateForTest,
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
    headers: { "x-useagent-release-fingerprint": fingerprint },
  });
}

afterEach(() => {
  resetReleaseReloadStateForTest();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
describe("release compatibility boundary", () => {
  test("adds the client release header to browser API requests only", () => {
    installWindow();
    const api = withClientReleaseHeader("/api/runs", { headers: { accept: "application/json" } });
    const nonApi = withClientReleaseHeader("/agent/new", { headers: { accept: "text/html" } });

    expect(new Headers(api?.headers).get("x-useagent-client-release")).toBe(
      CLIENT_RELEASE_FINGERPRINT,
    );
    expect(new Headers(nonApi?.headers).get("x-useagent-client-release")).toBeNull();
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

  test("says plainly when a reload already happened and cannot change the served bundle", () => {
    const win = installWindow();
    window.sessionStorage.setItem("useagent.release.reload", CLIENT_RELEASE_FINGERPRINT);

    let caught: unknown;
    try {
      handleReleaseMismatch(responseWithFingerprint("run-events-v1:ffffffff"), { method: "POST" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FrontendReleaseMismatchError);
    expect((caught as FrontendReleaseMismatchError).reloadedAlready).toBe(true);
    expect((caught as Error).message).toContain("reload and try again");
    expect(win.reloaded()).toBe(false);
  });

  test("a second mutation in the same page load sees the reload as pending, not failed", () => {
    installWindow();
    const errors: FrontendReleaseMismatchError[] = [];
    for (let i = 0; i < 2; i += 1) {
      try {
        handleReleaseMismatch(responseWithFingerprint("run-events-v1:eeeeeeee"), { method: "POST" });
      } catch (error) {
        errors.push(error as FrontendReleaseMismatchError);
      }
    }
    expect(errors.map((e) => e.reloadedAlready)).toEqual([false, false]);
  });
});
