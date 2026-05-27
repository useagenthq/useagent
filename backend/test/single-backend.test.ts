// Gate 1 (Phase 1 closure): the single-backend guard. Canonicalization sealing + the
// realtime SSE fan-out are process-local, so exactly one backend per database is supported
// for this release. The guard is a per-database Postgres advisory lock held for the process
// lifetime. Importing helpers boots src/index, which already acquired the skynet_test
// singleton lock - so a SECOND enforceSingleBackend() here must observe the lock as HELD.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  enforceSingleBackend,
  singleBackendRequired,
} from "../src/db/single-backend";
import { waitFor } from "./helpers"; // side-effect: boots src/index -> acquires the singleton lock

describe("single-backend guard (release enforcement)", () => {
  test("parses production booleans strictly", () => {
    expect(singleBackendRequired(undefined)).toBe(false);
    expect(singleBackendRequired("0")).toBe(false);
    expect(singleBackendRequired("false")).toBe(false);
    expect(singleBackendRequired("1")).toBe(true);
    expect(singleBackendRequired("true")).toBe(true);
    expect(() => singleBackendRequired("yes")).toThrow("REQUIRE_SINGLE_BACKEND");
  });

  test("a SECOND acquisition on the same DB is refused (lock already held by boot)", async () => {
    await waitFor(() => true, 1); // ensure boot (and its lock acquisition) has run
    // REQUIRE_SINGLE_BACKEND is unset in tests, so the fatal path is not taken; the call
    // returns false (warn-and-continue), proving a duplicate backend is DETECTED.
    const acquired = await enforceSingleBackend();
    expect(acquired).toBe(false);
  });

  test("strict mode fails closed when the advisory lock is unavailable", async () => {
    const connect = (() => ({
      reserve: async () => {
        throw new Error("database unavailable");
      },
      end: async () => {},
    })) as unknown as typeof postgres;

    await expect(enforceSingleBackend({ required: true, connect })).rejects.toThrow(
      "single-backend guard unavailable",
    );
  });

  test("strict mode rejects a duplicate backend", async () => {
    await expect(enforceSingleBackend({ required: true })).rejects.toThrow(
      "another skynet backend already holds",
    );
  });

  test("acquires the singleton before migrations or boot recovery", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const singleton = source.indexOf("await enforceSingleBackend()");
    const migrations = source.indexOf("await migrate(");
    const recovery = source.indexOf("await recoverStaleRuns()");

    expect(singleton).toBeGreaterThan(-1);
    expect(singleton).toBeLessThan(migrations);
    expect(singleton).toBeLessThan(recovery);
  });
});
