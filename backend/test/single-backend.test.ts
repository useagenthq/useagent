// Gate 1 (Phase 1 closure): the single-backend guard. Canonicalization sealing + the
// realtime SSE fan-out are process-local, so exactly one backend per database is supported
// for this release. The guard is a per-database Postgres advisory lock held for the process
// lifetime. Importing helpers boots src/index, which already acquired the skynet_test
// singleton lock - so a SECOND enforceSingleBackend() here must observe the lock as HELD.

import { describe, expect, test } from "bun:test";
import { enforceSingleBackend } from "../src/db/single-backend";
import { waitFor } from "./helpers"; // side-effect: boots src/index -> acquires the singleton lock

describe("single-backend guard (release enforcement)", () => {
  test("a SECOND acquisition on the same DB is refused (lock already held by boot)", async () => {
    await waitFor(() => true, 1); // ensure boot (and its lock acquisition) has run
    // REQUIRE_SINGLE_BACKEND is unset in tests, so the fatal path is not taken; the call
    // returns false (warn-and-continue), proving a duplicate backend is DETECTED.
    const acquired = await enforceSingleBackend();
    expect(acquired).toBe(false);
  });
});
