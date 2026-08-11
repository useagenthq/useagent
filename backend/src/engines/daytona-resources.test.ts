import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  assertSandboxResources,
  resolveSandboxResourceTarget,
  sandboxMeetsResourceTarget,
} from "./daytona-resources";

const sandboxWithResources = (cpu: number, memory: number) => ({ cpu, memory }) as SandboxHandle;

describe("Daytona sandbox resource policy", () => {
  test("defaults browser-capable engines to the proven 2 CPU / 8 GiB profile", () => {
    expect(resolveSandboxResourceTarget({})).toEqual({ cpu: 2, memory: 8 });
  });

  test("accepts explicit deployment overrides", () => {
    expect(
      resolveSandboxResourceTarget({
        SANDBOX_CPU: "8",
        SANDBOX_MEMORY_GIB: "32",
      }),
    ).toEqual({ cpu: 8, memory: 32 });
  });

  test("rejects invalid overrides rather than silently provisioning an undersized box", () => {
    expect(() => resolveSandboxResourceTarget({ SANDBOX_CPU: "0" })).toThrow(
      "SANDBOX_CPU must be an integer",
    );
    expect(() => resolveSandboxResourceTarget({ SANDBOX_MEMORY_GIB: "eight" })).toThrow(
      "SANDBOX_MEMORY_GIB must be an integer",
    );
  });

  test("rejects an undersized snapshot before the harness starts", () => {
    const sandbox = sandboxWithResources(1, 1);

    expect(sandboxMeetsResourceTarget(sandbox, { cpu: 2, memory: 8 })).toBe(false);
    expect(() => assertSandboxResources(sandbox, { cpu: 2, memory: 8 })).toThrow(
      "resources are below the required target",
    );
  });

  test("accepts a larger box without mutating it", () => {
    const sandbox = sandboxWithResources(8, 16);

    expect(assertSandboxResources(sandbox, { cpu: 2, memory: 8 })).toEqual({
      cpu: 8,
      memory: 16,
    });
  });
});
