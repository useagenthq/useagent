import { afterEach, describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  evaluateVisibleBrowserPage,
  navigateVisibleBrowserPage,
  setBrowserControlTransportForTest,
  waitForCdpSocketOpen,
} from "./browser-mcp";

class FakeWebSocket extends EventTarget {
  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
  }
}

describe("host-owned browser control", () => {
  afterEach(() => setBrowserControlTransportForTest(null));

  test("evaluates and navigates without a sandbox command", async () => {
    const calls: string[] = [];
    const sandbox = {} as SandboxHandle;
    setBrowserControlTransportForTest({
      evaluate: async <T>(_sandbox: SandboxHandle, expression: string) => {
        calls.push(`evaluate:${expression}`);
        return { ready: true } as T;
      },
      navigate: async (_sandbox, url) => {
        calls.push(`navigate:${url}`);
      },
    });

    await expect(
      evaluateVisibleBrowserPage<{ ready: boolean }>(sandbox, "({ ready: true })"),
    ).resolves.toEqual({ ready: true });
    await navigateVisibleBrowserPage(sandbox, "https://example.com/secret");
    expect(calls).toEqual([
      "evaluate:({ ready: true })",
      "navigate:https://example.com/secret",
    ]);
  });

  test("fails closed when host control fails", async () => {
    setBrowserControlTransportForTest({
      evaluate: async () => {
        throw new Error("CDP unavailable");
      },
      navigate: async () => {},
    });

    await expect(
      evaluateVisibleBrowserPage({} as SandboxHandle, "location.href"),
    ).rejects.toThrow("CDP unavailable");
  });

  test("closes a socket that does not open before the deadline", async () => {
    const socket = new FakeWebSocket();

    await expect(waitForCdpSocketOpen(socket, 1)).rejects.toThrow(
      "CDP connection timed out",
    );
    expect(socket.closeCalls).toBe(1);

    socket.dispatchEvent(new Event("open"));
    expect(socket.closeCalls).toBe(1);
  });

  test("closes a socket that fails while connecting", async () => {
    const socket = new FakeWebSocket();
    const opening = waitForCdpSocketOpen(socket, 1_000);

    socket.dispatchEvent(new Event("error"));

    await expect(opening).rejects.toThrow("CDP connection failed");
    expect(socket.closeCalls).toBe(1);
  });
});
