import { describe, expect, test } from "bun:test";
import {
  connectDesktopRunner,
  localRunnerAvailable,
  machineLabel,
  resolveRunnerPlatform,
  runnerConnectionAction,
  type UseAgentDesktopBridge,
} from "./desktop-bridge";

describe("desktop runner platform", () => {
  test("uses Chromium high-entropy architecture instead of guessing from the OS", async () => {
    const arm = { getHighEntropyValues: async () => ({ architecture: "arm", bitness: "64" }) };
    const x64 = { getHighEntropyValues: async () => ({ architecture: "x86", bitness: "64" }) };
    expect(await resolveRunnerPlatform("darwin", arm)).toBe("darwin-arm64");
    expect(await resolveRunnerPlatform("linux", x64)).toBe("linux-x64");
    expect(await resolveRunnerPlatform("win32", arm)).toBeNull();
  });

  test("fails closed when architecture is missing or unreadable", async () => {
    expect(await resolveRunnerPlatform("darwin", undefined)).toBeNull();
    expect(
      await resolveRunnerPlatform("darwin", {
        getHighEntropyValues: async () => {
          throw new Error("unavailable");
        },
      }),
    ).toBeNull();
  });

  test("offers a local runner on macOS only", () => {
    expect(localRunnerAvailable("darwin")).toBe(true);
    expect(localRunnerAvailable("win32")).toBe(false);
    expect(localRunnerAvailable("linux")).toBe(false);
  });

  test("uses plain machine labels", () => {
    expect(machineLabel("darwin")).toBe("This Mac");
    expect(machineLabel("win32")).toBe("This Windows PC");
  });

  test("does not reconnect a runner that is starting, pulling, or online", () => {
    expect(runnerConnectionAction(null, "darwin")).toEqual({
      active: true,
      label: "Checking runner",
    });
    expect(runnerConnectionAction({ state: "starting" }, "darwin").active).toBe(true);
    expect(runnerConnectionAction({ state: "pulling" }, "darwin").active).toBe(true);
    expect(runnerConnectionAction({ state: "online" }, "darwin")).toEqual({
      active: true,
      label: "Connected",
    });
    expect(runnerConnectionAction({ state: "offline" }, "darwin").active).toBe(false);
  });

  test("hands the one-time enrolment token directly to the bridge", async () => {
    const calls: string[] = [];
    const bridge: UseAgentDesktopBridge = {
      version: "0.0.5",
      platform: "darwin",
      connectRunner: async (token) => {
        calls.push(`connect:${token}`);
      },
      runnerStatus: async () => ({ state: "offline" }),
      openExternal: () => {},
    };
    await connectDesktopRunner(bridge, "darwin-arm64", async (input) => {
      calls.push(`enrol:${input.name}:${input.platform}`);
      return { runnerId: "rn_a", token: "once" };
    });
    expect(calls).toEqual(["enrol:This Mac:darwin-arm64", "connect:once"]);
  });
});
