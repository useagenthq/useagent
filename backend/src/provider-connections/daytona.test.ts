import { describe, expect, test } from "bun:test";
import {
  DaytonaConnectionValidationError,
  daytonaValidationHttpStatus,
  validateDaytonaConnection,
} from "./daytona";

describe("Daytona provider connection validation", () => {
  test("accepts only the exact active snapshot without provisioning", async () => {
    const calls: string[] = [];
    await validateDaytonaConnection(
      { apiKey: "secret", snapshotName: "useagent-runtime-v17" },
      {
        createClient: () => ({
          snapshot: {
            get: async (name) => {
              calls.push(name);
              return { name, state: "active" };
            },
          },
        }),
      },
    );
    expect(calls).toEqual(["useagent-runtime-v17"]);
  });

  test("rejects a non-active or mismatched snapshot", async () => {
    for (const snapshot of [
      { name: "useagent-runtime-v17", state: "building" },
      { name: "other", state: "active" },
    ]) {
      await expect(validateDaytonaConnection(
        { apiKey: "secret", snapshotName: "useagent-runtime-v17" },
        { createClient: () => ({ snapshot: { get: async () => snapshot } }) },
      )).rejects.toMatchObject({ code: "snapshot_not_active" });
    }
  });

  test("preserves the validation result when SDK disposal fails", async () => {
    await expect(validateDaytonaConnection(
      { apiKey: "secret", snapshotName: "missing" },
      {
        createClient: () => ({
          snapshot: {
            get: async () => ({ name: "other", state: "active" }),
          },
          [Symbol.asyncDispose]: async () => {
            throw new Error("dispose failed");
          },
        }),
      },
    )).rejects.toMatchObject({ code: "snapshot_not_active" });
  });

  test("fails a successful validation when SDK disposal fails", async () => {
    await expect(validateDaytonaConnection(
      { apiKey: "secret", snapshotName: "useagent-runtime-v17" },
      {
        createClient: () => ({
          snapshot: {
            get: async (name) => ({ name, state: "active" }),
          },
          [Symbol.asyncDispose]: async () => {
            throw new Error("dispose failed");
          },
        }),
      },
    )).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  test("maps validation codes to stable HTTP statuses", () => {
    expect(daytonaValidationHttpStatus("authentication_failed")).toBe(401);
    expect(daytonaValidationHttpStatus("forbidden")).toBe(403);
    expect(daytonaValidationHttpStatus("snapshot_not_found")).toBe(404);
    expect(daytonaValidationHttpStatus("snapshot_not_active")).toBe(409);
    expect(daytonaValidationHttpStatus("rate_limited")).toBe(429);
    expect(daytonaValidationHttpStatus("provider_unavailable")).toBe(503);
    expect(new DaytonaConnectionValidationError("provider_unavailable").message).toBe(
      "provider_unavailable",
    );
  });
});
