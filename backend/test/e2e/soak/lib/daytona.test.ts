import { expect, test } from "bun:test";
import {
  classifySandboxForSweep,
  includeSandboxInInventory,
} from "./daytona";
import { readSandboxRunLabel } from "../../../../src/sandboxes/label-compat";

test("cleanup accepts compatible run labels and spares conflicts", () => {
  expect(readSandboxRunLabel({ "skynet-run": "run-1" })).toEqual({ value: "run-1", conflict: false });
  expect(readSandboxRunLabel({ "useagent-run": "run-1" })).toEqual({ value: "run-1", conflict: false });
  expect(readSandboxRunLabel({ "useagent-run": "run-1", "skynet-run": "run-1" }))
    .toEqual({ value: "run-1", conflict: false });
  expect(readSandboxRunLabel({ "useagent-run": "run-new", "skynet-run": "run-old" }))
    .toEqual({ value: null, conflict: true });

  const conflict = classifySandboxForSweep({
    id: "sandbox-conflict",
    state: "stopped",
    labels: { "useagent-run": "run-new", "skynet-run": "run-old" },
    createdAt: undefined,
  }, new Set(), new Set());
  expect(conflict).toMatchObject({ targeted: false, reason: "conflicting run labels" });
});

test("inventory selection preserves default, unfiltered, and custom-label modes", () => {
  expect(includeSandboxInInventory({}, undefined)).toBe(false);
  expect(includeSandboxInInventory({}, "")).toBe(true);
  expect(includeSandboxInInventory({ "skynet-run": "" }, undefined)).toBe(true);
  expect(includeSandboxInInventory({ "useagent-run": "new", "skynet-run": "old" }, undefined))
    .toBe(true);
  expect(includeSandboxInInventory({ custom: "" }, "custom")).toBe(true);
  expect(includeSandboxInInventory({}, "custom")).toBe(false);
});
