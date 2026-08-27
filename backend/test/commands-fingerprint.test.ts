import { describe, expect, test } from "bun:test";
import {
  runIntentFingerprint,
  runIntentFromAcceptedRun,
} from "../src/commands/fingerprint";
import type { RunCommandInput, RunCommandIntent } from "../src/commands/types";
import type { RunResource } from "../src/resources/types";
import { decodeRunResourceSelections } from "../src/resources/run-intake";

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

const pullRequestResource: RunResource = {
  kind: "code.change",
  provider: "github",
  locator: {
    type: "github.pull_request",
    repository: "acme/api",
    number: 42,
    revision: "abc123",
  },
  capabilities: ["content.read", "code.checkout", "change.read"],
  provenance: [
    {
      source: "user_text",
      channel: "web",
      raw: "https://github.com/acme/api/pull/42",
      start: 5,
      end: 39,
    },
  ],
};

describe("runIntentFingerprint", () => {
  test("deterministic for identical intent", () => {
    expect(runIntentFingerprint(runIntentFromAcceptedRun(base))).toBe(
      runIntentFingerprint(runIntentFromAcceptedRun({ ...base })),
    );
  });

  test("ignores run id and thread id (identity, not intent)", () => {
    const other = runIntentFingerprint(
      runIntentFromAcceptedRun({ ...base, id: "run-b", threadId: "thread-b" }),
    );
    expect(other).toBe(runIntentFingerprint(runIntentFromAcceptedRun(base)));
  });

  test("changes when any intent field changes", () => {
    const intent = runIntentFromAcceptedRun(base);
    const fp = runIntentFingerprint(intent);
    expect(runIntentFingerprint({ ...intent, prompt: "different" })).not.toBe(fp);
    expect(runIntentFingerprint({ ...intent, model: "claude-sonnet-4-5" })).not.toBe(fp);
    expect(runIntentFingerprint({ ...intent, engine: "mock" })).not.toBe(fp);
    expect(runIntentFingerprint({ ...intent, parentRunId: "run-x" })).not.toBe(fp);
  });

  test("branch is intent: a different repo branch changes the fingerprint", () => {
    // The chosen branch rides encoded on the repo string ("owner/name:branch"),
    // so it participates in the fingerprint for free - a keyed replay that only
    // changes the branch is a payload mismatch, NOT a silent reuse of the other
    // branch's run.
    const intent = runIntentFromAcceptedRun(base);
    const defaultBranch = runIntentFingerprint({ ...intent, requestedRepos: ["acme/api"] });
    const develop = runIntentFingerprint({ ...intent, requestedRepos: ["acme/api:develop"] });
    const feature = runIntentFingerprint({ ...intent, requestedRepos: ["acme/api:feat/x"] });
    expect(develop).not.toBe(defaultBranch); // explicit branch != default
    expect(develop).not.toBe(feature); // one branch != another
    // Same repo + same branch is the same intent (deterministic replay).
    expect(runIntentFingerprint({ ...intent, requestedRepos: ["acme/api:develop"] })).toBe(develop);
  });

  test("memory scope is intent: org vs personal fingerprints differ (audit finding)", () => {
    const intent = runIntentFromAcceptedRun(base);
    const org = runIntentFingerprint({ ...intent, memoryScope: "org" });
    const personal = runIntentFingerprint({ ...intent, memoryScope: "personal" });
    expect(org).not.toBe(personal);
    // Legacy payloads without a scope stay stable relative to themselves.
    expect(runIntentFingerprint(intent)).toBe(runIntentFingerprint({ ...intent }));
  });

  test("attached upload ids are part of the durable intent", () => {
    const intent = runIntentFromAcceptedRun(base);
    const withoutFiles = runIntentFingerprint({ ...intent, attachmentIds: [] });
    const withFile = runIntentFingerprint({ ...intent, attachmentIds: [crypto.randomUUID()] });
    expect(withFile).not.toBe(withoutFiles);
  });

  test("typed resource selections are part of the durable intent", () => {
    const intent = runIntentFromAcceptedRun(base);
    const withoutResources = runIntentFingerprint({ ...intent, requestedResources: [] });
    const withThread = runIntentFingerprint({
      ...intent,
      requestedResources: [{
        kind: "thread",
        provider: "useagent",
        locator: { type: "thread", id: "run-reference" },
      }],
    });
    expect(withThread).not.toBe(withoutResources);
  });

  test("raw resource key order canonicalizes to one deterministic fingerprint", () => {
    const intent = runIntentFromAcceptedRun(base);
    const first = decodeRunResourceSelections([{
      kind: "code.change",
      provider: "github",
      locator: {
        type: "github.pull_request",
        repository: "acme/api",
        number: 42,
        revision: null,
      },
    }]);
    const reordered = decodeRunResourceSelections([{
      locator: {
        revision: null,
        number: 42,
        repository: "acme/api",
        type: "github.pull_request",
      },
      provider: "github",
      kind: "code.change",
    }]);
    expect(first).not.toBeNull();
    expect(reordered).not.toBeNull();
    expect(runIntentFingerprint({
      ...intent,
      requestedResources: first!,
    })).toBe(runIntentFingerprint({
      ...intent,
      requestedResources: reordered!,
    }));
  });

  test("derived resources, provider revisions, and provenance never affect intent", () => {
    const acceptedAtHeadA = runIntentFromAcceptedRun({
      ...base,
      resolvedResources: [pullRequestResource],
    });
    const acceptedAtHeadB = runIntentFromAcceptedRun({
      ...base,
      resolvedResources: [{
        ...pullRequestResource,
        locator: { ...pullRequestResource.locator, revision: "different-sha" },
        provenance: [{
          source: "legacy_parent",
          channel: "slack",
          raw: "different",
          start: null,
          end: null,
        }],
      }],
    });
    expect(runIntentFingerprint(acceptedAtHeadB)).toBe(
      runIntentFingerprint(acceptedAtHeadA),
    );
  });

  test("the FULL command identity is intent (D5): provider/session/revision each change the fingerprint", () => {
    // A validated `/compact` on claude, authorized against session s1 @ revision 5.
    const cmd: RunCommandIntent = {
      ...runIntentFromAcceptedRun(base),
      commandName: "compact",
      commandProvider: "claude",
      commandSessionId: "s1",
      commandCatalogRevision: 5,
    };
    const fp = runIntentFingerprint(cmd);
    // Same NAME but a different authorization (provider/session/revision) is a DIFFERENT intent -
    // a keyed replay that changes any one of them must NOT silently reuse the other run.
    expect(runIntentFingerprint({ ...cmd, commandProvider: "codex" })).not.toBe(fp);
    expect(runIntentFingerprint({ ...cmd, commandSessionId: "s2" })).not.toBe(fp);
    expect(runIntentFingerprint({ ...cmd, commandCatalogRevision: 6 })).not.toBe(fp);
    // Identical identity is the same intent (deterministic replay).
    expect(runIntentFingerprint({ ...cmd })).toBe(fp);
    // The name alone no longer stands in for identity: a bare command name (no provider/session)
    // differs from the fully-identified one.
    expect(
      runIntentFingerprint({ ...runIntentFromAcceptedRun(base), commandName: "compact" }),
    ).not.toBe(fp);
  });
});
