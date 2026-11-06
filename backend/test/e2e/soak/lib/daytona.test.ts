import { expect, test } from "bun:test";
import {
  classifySandboxForSweep,
  includeSandboxInInventory,
} from "./daytona";
import { readSandboxRunLabel } from "../../../../src/sandboxes/label-compat";
import { LEGACY_SANDBOX_RUN_LABEL } from "../../../../src/sandboxes/label-compat";

test("cleanup accepts compatible run labels and spares conflicts", () => {
  expect(readSandboxRunLabel({ [LEGACY_SANDBOX_RUN_LABEL]: "run-1" })).toEqual({ value: "run-1", conflict: false });
  expect(readSandboxRunLabel({ "useagent-run": "run-1" })).toEqual({ value: "run-1", conflict: false });
  expect(readSandboxRunLabel({ "useagent-run": "run-1", [LEGACY_SANDBOX_RUN_LABEL]: "run-1" }))
    .toEqual({ value: "run-1", conflict: false });
  expect(readSandboxRunLabel({ "useagent-run": "run-new", [LEGACY_SANDBOX_RUN_LABEL]: "run-old" }))
    .toEqual({ value: null, conflict: true });

  const conflict = classifySandboxForSweep({
    id: "sandbox-conflict",
    state: "stopped",
    labels: { "useagent-run": "run-new", [LEGACY_SANDBOX_RUN_LABEL]: "run-old" },
    createdAt: undefined,
  }, new Set(), new Set());
  expect(conflict).toMatchObject({ targeted: false, reason: "conflicting run labels" });
});

test("inventory selection preserves default, unfiltered, and custom-label modes", () => {
  expect(includeSandboxInInventory({}, undefined)).toBe(false);
  expect(includeSandboxInInventory({}, "")).toBe(true);
  expect(includeSandboxInInventory({ [LEGACY_SANDBOX_RUN_LABEL]: "" }, undefined)).toBe(true);
  expect(includeSandboxInInventory({ "useagent-run": "new", [LEGACY_SANDBOX_RUN_LABEL]: "old" }, undefined))
    .toBe(true);
  expect(includeSandboxInInventory({ custom: "" }, "custom")).toBe(true);
  expect(includeSandboxInInventory({}, "custom")).toBe(false);
});
