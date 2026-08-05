import { describe, expect, test } from "bun:test";
import { opencodeHarness } from "../src/engines/opencode-server";
import type { HarnessSessionHandle } from "../src/engines/types";

// Contract test for the Stage-1 typed harness seam. The control ops resolve to
// classified, non-throwing results even with no reachable sandbox — the key
// invariant behind restart/cancel safety. (Reachable-sandbox behavior is proven
// live in the reconcile integration on :3503.)

const HANDLE: HarnessSessionHandle = {
  provider: "opencode",
  sessionId: "ses_x",
  sandboxId: "does-not-exist",
};

describe("opencode harness seam", () => {
  test("capabilities() reports opencode's native support", () => {
    const caps = opencodeHarness.capabilities();
    expect(opencodeHarness.provider).toBe("opencode");
    expect(caps.cancel).toBe(true);
    expect(caps.resume).toBe(true);
    expect(caps.streaming).toBe("parts");
    expect(caps.authoritativeHistory).toBe(true);
    expect(caps.childSessions).toBe(true);
    // A fresh object each call — callers can't mutate the shared capability map.
    expect(opencodeHarness.capabilities()).not.toBe(caps);
  });

  test("cancel + reconcile return typed results (never throw) when unreachable", async () => {
    const saved = process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_KEY;
    try {
      const t0 = Date.now();
      const cancelled = await opencodeHarness.cancel(HANDLE, "user requested stop");
      expect(cancelled.status).toBe("error");
      if (cancelled.status === "error") expect(cancelled.code).toBe("sandbox_unreachable");

      const rec = await opencodeHarness.reconcile(HANDLE, { sinceMs: 0 });
      expect(rec.status).toBe("unreachable");

      // Both are bounded — an unreachable sandbox never hangs a control op.
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally {
      if (saved !== undefined) process.env.DAYTONA_API_KEY = saved;
    }
  });
});
