import { describe, expect, test } from "bun:test";
import { runPayloadFingerprint } from "../src/commands/fingerprint";
import type { RunCommandInput } from "../src/commands/types";

// Pure single-purpose unit: the idempotency fingerprint depends ONLY on the
// user's intent (prompt/model/engine/parent), never on the pre-allocated run id
// or thread id.

const base: RunCommandInput["run"] = {
  id: "run-a",
  prompt: "build a rate limiter",
  model: "claude-opus-5",
  engine: "opencode",
  parentRunId: null,
  threadId: "thread-a",
};

describe("runPayloadFingerprint", () => {
  test("deterministic for identical intent", () => {
    expect(runPayloadFingerprint(base)).toBe(runPayloadFingerprint({ ...base }));
  });

  test("ignores run id and thread id (identity, not intent)", () => {
    const other = runPayloadFingerprint({ ...base, id: "run-b", threadId: "thread-b" });
    expect(other).toBe(runPayloadFingerprint(base));
  });

  test("changes when any intent field changes", () => {
    const fp = runPayloadFingerprint(base);
    expect(runPayloadFingerprint({ ...base, prompt: "different" })).not.toBe(fp);
    expect(runPayloadFingerprint({ ...base, model: "claude-sonnet-4-5" })).not.toBe(fp);
    expect(runPayloadFingerprint({ ...base, engine: "mock" })).not.toBe(fp);
    expect(runPayloadFingerprint({ ...base, parentRunId: "run-x" })).not.toBe(fp);
  });
});
