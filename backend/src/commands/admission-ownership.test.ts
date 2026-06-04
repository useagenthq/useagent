import { describe, expect, test } from "bun:test";
import {
  resolveAdmissionChange,
  RunAdmissionOwnershipError,
  type AdmissionOwnerState,
} from "./admission-ownership";

const open: AdmissionOwnerState = {
  open: true,
  operationId: "bootstrap",
};

function change(open: boolean, operationId: string) {
  return { open, operationId, actor: "test", reason: "test" };
}

describe("deployment admission ownership", () => {
  test("interleaved operation B cannot close or reopen operation A's boundary", () => {
    expect(resolveAdmissionChange(open, change(false, "operation-a"))).toBe("apply");
    const ownedByA: AdmissionOwnerState = { ...open, open: false, operationId: "operation-a" };

    expect(() => resolveAdmissionChange(ownedByA, change(false, "operation-b"))).toThrow(
      RunAdmissionOwnershipError,
    );
    expect(() => resolveAdmissionChange(ownedByA, change(true, "operation-b"))).toThrow(
      RunAdmissionOwnershipError,
    );
    expect(resolveAdmissionChange(ownedByA, change(true, "operation-a"))).toBe("apply");
  });

  test("nested release, gate, and restart calls remain idempotent under one owner", () => {
    const releaseOwned: AdmissionOwnerState = {
      open: false,
      operationId: "release:20260825T120000Z",
    };

    expect(resolveAdmissionChange(releaseOwned, change(false, releaseOwned.operationId))).toBe(
      "unchanged",
    );
    expect(resolveAdmissionChange(releaseOwned, change(true, releaseOwned.operationId))).toBe(
      "apply",
    );
  });
});
