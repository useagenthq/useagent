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

  test("branch is intent: a different repo branch changes the fingerprint", () => {
    // The chosen branch rides encoded on the repo string ("owner/name:branch"),
    // so it participates in the fingerprint for free - a keyed replay that only
    // changes the branch is a payload mismatch, NOT a silent reuse of the other
    // branch's run.
    const defaultBranch = runPayloadFingerprint({ ...base, repos: ["acme/api"] });
    const develop = runPayloadFingerprint({ ...base, repos: ["acme/api:develop"] });
    const feature = runPayloadFingerprint({ ...base, repos: ["acme/api:feat/x"] });
    expect(develop).not.toBe(defaultBranch); // explicit branch != default
    expect(develop).not.toBe(feature); // one branch != another
    // Same repo + same branch is the same intent (deterministic replay).
    expect(runPayloadFingerprint({ ...base, repos: ["acme/api:develop"] })).toBe(develop);
  });

  test("memory scope is intent: org vs personal fingerprints differ (audit finding)", () => {
    const org = runPayloadFingerprint({ ...base, memoryScope: "org" });
    const personal = runPayloadFingerprint({ ...base, memoryScope: "personal" });
    expect(org).not.toBe(personal);
    // Legacy payloads without a scope stay stable relative to themselves.
    expect(runPayloadFingerprint(base)).toBe(runPayloadFingerprint({ ...base }));
  });

  test("attached upload ids are part of the durable intent", () => {
    const withoutFiles = runPayloadFingerprint({ ...base, attachmentIds: [] });
    const withFile = runPayloadFingerprint({ ...base, attachmentIds: [crypto.randomUUID()] });
    expect(withFile).not.toBe(withoutFiles);
  });

  test("the FULL command identity is intent (D5): provider/session/revision each change the fingerprint", () => {
    // A validated `/compact` on claude, authorized against session s1 @ revision 5.
    const cmd = {
      ...base,
      commandName: "compact",
      commandProvider: "claude",
      commandSessionId: "s1",
      commandCatalogRevision: 5,
    };
    const fp = runPayloadFingerprint(cmd);
    // Same NAME but a different authorization (provider/session/revision) is a DIFFERENT intent -
    // a keyed replay that changes any one of them must NOT silently reuse the other run.
    expect(runPayloadFingerprint({ ...cmd, commandProvider: "codex" })).not.toBe(fp);
    expect(runPayloadFingerprint({ ...cmd, commandSessionId: "s2" })).not.toBe(fp);
    expect(runPayloadFingerprint({ ...cmd, commandCatalogRevision: 6 })).not.toBe(fp);
    // Identical identity is the same intent (deterministic replay).
    expect(runPayloadFingerprint({ ...cmd })).toBe(fp);
    // The name alone no longer stands in for identity: a bare command name (no provider/session)
    // differs from the fully-identified one.
    expect(runPayloadFingerprint({ ...base, commandName: "compact" })).not.toBe(fp);
  });
});
