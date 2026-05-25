// Pure policy for the internal-run marker (memory self-improvement item 2):
// derivation from the explicit identifiers our canaries/harnesses stamp, and the
// finalize-side internal check. No prompt sniffing — prompts never participate.
import { describe, expect, test } from "bun:test";
import { deriveRunOrigin, isInternalRunOrigin } from "./origin";

describe("deriveRunOrigin — internal markers from idempotency key / run id", () => {
  test("parity canary keys mark the run internal", () => {
    expect(deriveRunOrigin("t3-parity:case-1:codex:tok:0", "run-uuid")).toBe("t3-parity");
    expect(deriveRunOrigin("release-eval:c2:opencode:tok:1", "run-uuid")).toBe("release-eval");
    expect(deriveRunOrigin("hosted-release-canary:upload:abc", "run-uuid")).toBe(
      "hosted-release-canary",
    );
  });

  test("harness run-id prefixes match when there is no key", () => {
    expect(deriveRunOrigin(null, `t3-parity-case-codex-${crypto.randomUUID()}`)).toBe("t3-parity");
    expect(deriveRunOrigin(null, "PARITY_QC_PROBE_7")).toBe("parity");
    expect(deriveRunOrigin(null, "e2e-3f6d")).toBe("e2e");
  });

  test("e2e keys match case-insensitively at a token boundary only", () => {
    expect(deriveRunOrigin(`e2e-${crypto.randomUUID()}`, "run-uuid")).toBe("e2e");
    expect(deriveRunOrigin("E2E:stage-1", "run-uuid")).toBe("e2e");
    // Merely CONTAINING a marker (or extending it into a longer word) never matches.
    expect(deriveRunOrigin("e2energy-report", "run-uuid")).toBeNull();
    expect(deriveRunOrigin("my-canary-thing", "run-uuid")).toBeNull();
  });

  test("product channels and plain UUIDs stay null", () => {
    expect(deriveRunOrigin(null, crypto.randomUUID())).toBeNull();
    expect(deriveRunOrigin("slack-ack:C123:1712.9", crypto.randomUUID())).toBeNull();
    expect(deriveRunOrigin("child-session:t:parent:k", crypto.randomUUID())).toBeNull();
    expect(deriveRunOrigin(`sched:s1:cron:2026-08-20T00:00`, crypto.randomUUID())).toBeNull();
  });
});

describe("isInternalRunOrigin", () => {
  test("null (every product run) is never internal", () => {
    expect(isInternalRunOrigin(null)).toBe(false);
  });

  test("stored markers — including compound values — read as internal", () => {
    expect(isInternalRunOrigin("t3-parity")).toBe(true);
    expect(isInternalRunOrigin("canary")).toBe(true);
    expect(isInternalRunOrigin("parity-canary")).toBe(true);
  });

  test("an unknown non-internal origin value is not excluded", () => {
    expect(isInternalRunOrigin("slack")).toBe(false);
  });
});
