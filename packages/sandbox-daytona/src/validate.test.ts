import { describe, expect, test } from "bun:test";
import {
  DaytonaAuthenticationError,
  DaytonaForbiddenError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaServiceUnavailableError,
  DaytonaTimeoutError,
} from "@daytona/sdk";
import { SandboxCredentialError } from "@useagent/sandbox-contract";
import { validateDaytonaConnection } from "./validate";

describe("Daytona credential validation", () => {
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

  test("rejects a non-active or mismatched snapshot as not found", async () => {
    for (const snapshot of [
      { name: "useagent-runtime-v17", state: "building" },
      { name: "other", state: "active" },
    ]) {
      const error = await validateDaytonaConnection(
        { apiKey: "secret", snapshotName: "useagent-runtime-v17" },
        { createClient: () => ({ snapshot: { get: async () => snapshot } }) },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxCredentialError);
      expect(error).toMatchObject({ code: "snapshot_not_found", httpStatus: 404 });
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
    )).rejects.toMatchObject({ code: "snapshot_not_found", httpStatus: 404 });
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
    )).rejects.toMatchObject({ code: "provider_unavailable", httpStatus: 503 });
  });

  test("SDK failures map onto the shared credential codes and statuses", async () => {
    for (const [failure, code, httpStatus] of [
      [new DaytonaAuthenticationError("bad key", 401), "authentication_failed", 401],
      [new DaytonaForbiddenError("no access", 403), "forbidden", 403],
      [new DaytonaNotFoundError("missing", 404), "snapshot_not_found", 404],
      [new DaytonaRateLimitError("slow down", 429), "rate_limited", 429],
      [new DaytonaTimeoutError("timed out", 408), "provider_unavailable", 503],
      [new DaytonaServiceUnavailableError("down", 503), "provider_unavailable", 503],
    ] as const) {
      const error = await validateDaytonaConnection(
        { apiKey: "secret", snapshotName: "useagent-runtime-v17" },
        { createClient: () => ({ snapshot: { get: async () => { throw failure; } } }) },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxCredentialError);
      expect(error).toMatchObject({ code, httpStatus, message: code });
    }
  });

  test("unrecognized failures pass through untouched", async () => {
    const unknown = new Error("socket hang up");
    await expect(validateDaytonaConnection(
      { apiKey: "secret", snapshotName: "useagent-runtime-v17" },
      { createClient: () => ({ snapshot: { get: async () => { throw unknown; } } }) },
    )).rejects.toBe(unknown);
  });
});
