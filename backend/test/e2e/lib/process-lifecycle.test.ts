import { describe, expect, test } from "bun:test";
import {
  type OwnedProcess,
  stopOwnedProcess,
  stopOwnedProcesses,
} from "./process-lifecycle";

function fakeProcess(options: { exitOn?: "SIGTERM" | "SIGKILL"; pid: number }) {
  const signals: NodeJS.Signals[] = [];
  const { promise, resolve } = Promise.withResolvers<number>();
  const process: OwnedProcess = {
    pid: options.pid,
    exited: promise,
    kill(signal = "SIGTERM") {
      const named = typeof signal === "string" ? signal : "SIGTERM";
      signals.push(named);
      if (named === options.exitOn) resolve(0);
    },
  };
  return { process, signals };
}

describe("owned process teardown", () => {
  test("stops cooperatively with SIGTERM", async () => {
    const child = fakeProcess({ pid: 1, exitOn: "SIGTERM" });
    await stopOwnedProcess(child.process, 1);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("escalates a stubborn process to SIGKILL", async () => {
    const child = fakeProcess({ pid: 2, exitOn: "SIGKILL" });
    await stopOwnedProcess(child.process, 1);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("attempts every cleanup before returning an aggregate failure", async () => {
    const stuck = fakeProcess({ pid: 3 });
    const cooperative = fakeProcess({ pid: 4, exitOn: "SIGTERM" });
    await expect(
      stopOwnedProcesses([stuck.process, cooperative.process], 1),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(stuck.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(cooperative.signals).toEqual(["SIGTERM"]);
  });
});
