import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { RunResource } from "../../resources/types";
import type {
  GitHubChangeSetRecord,
  GitHubPublicationReceiptRecord,
} from "../../github/publication-repo";
import { approvalArgumentsHash } from "./approval-capability";
import {
  createGithubPublicationToolExecutor,
  type PublicationToolDependencies,
} from "./github-publication-tools";
import {
  advertisedGatewayToolDescriptor,
  gatewayToolRequiresApproval,
} from "./operation-registry";
import type { ToolTokenClaims } from "./token";
import { executeGithubToolLocal } from "./github-tools";
import { GitHubPublicationError } from "../../github/publisher";

const SHA = "a".repeat(40);
const COMMIT = "b".repeat(40);
const claims: ToolTokenClaims = {
  orgId: "org-a",
  userId: "user-a",
  threadId: "thread-a",
  runId: "run-a",
  scope: "run",
  exp: Date.now() + 60_000,
};

const resource: RunResource = {
  kind: "code.repository",
  provider: "github",
  locator: { type: "github.repository", repository: "acme/widget", revision: "main" },
  capabilities: ["content.read", "code.checkout"],
  provenance: [{
    source: "explicit",
    channel: "web",
    raw: "acme/widget",
    start: null,
    end: null,
  }],
};

function changeSet(overrides: Partial<GitHubChangeSetRecord> = {}): GitHubChangeSetRecord {
  return {
    id: "change-a",
    orgId: claims.orgId,
    userId: claims.userId,
    runId: claims.runId,
    threadId: claims.threadId,
    projectId: null,
    repoFullName: "acme/widget",
    baseRef: "main",
    baseSha: SHA,
    manifest: {
      version: 1,
      files: [{ path: "README.md", action: "modify", sha256: "x".repeat(64), sizeBytes: 2, mode: "100644" }],
    },
    manifestSizeBytes: 100,
    payloadStorageKey: "c".repeat(64),
    payloadSha256: "c".repeat(64),
    payloadSizeBytes: 100,
    fingerprint: "d".repeat(64),
    state: "frozen",
    frozenAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function receipt(overrides: Partial<GitHubPublicationReceiptRecord> = {}): GitHubPublicationReceiptRecord {
  return {
    id: "receipt-a",
    orgId: claims.orgId,
    changeSetId: "change-a",
    idempotencyKeyHash: "e".repeat(64),
    requestFingerprint: "f".repeat(64),
    state: "pending",
    targetBranch: "main",
    draft: false,
    commitMessage: "Update README",
    pullRequestTitle: "Update README",
    pullRequestBody: "Prepared by useAgent",
    headBranch: "useagent/readme",
    commitSha: null,
    pullRequestNumber: null,
    pullRequestUrl: null,
    attemptCount: 0,
    lastError: null,
    claimToken: null,
    claimExpiresAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function dependencies(overrides: Partial<PublicationToolDependencies> = {}): PublicationToolDependencies {
  const row = changeSet();
  const rec = receipt();
  return {
    getRun: async () => ({
      id: claims.runId,
      orgId: claims.orgId,
      userId: claims.userId,
      threadId: claims.threadId,
      projectId: null,
      sandboxId: "sandbox-a",
      resolvedResources: [resource],
    }) as never,
    resolveToken: async () => "server-secret",
    fetch: async () => Response.json({ object: { sha: SHA } }),
    putPayload: async () => {},
    readSandboxBundle: async () => Buffer.from(JSON.stringify({
      version: 1,
      changes: [{ path: "README.md", action: "modify", contentBase64: "aGk=", mode: "100644" }],
    })),
    readPayload: async () => new Uint8Array(),
    freeze: async () => ({ row, created: true }),
    getChangeSet: async () => row,
    getReceipt: async () => rec,
    ensureReceipt: async () => ({ row: rec, created: true }),
    claimPublish: async () => ({ receipt: { ...rec, state: "publishing" }, claimToken: "claim", mode: "publish" }),
    claimReconcile: async () => null,
    publish: async () => ({
      repository: "acme/widget",
      targetBranch: "main",
      headBranch: "useagent/readme",
      baseSha: SHA,
      treeSha: "1".repeat(40),
      commitSha: COMMIT,
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/acme/widget/pull/42",
    }),
    recordSuccess: async () => receipt({ state: "published", commitSha: COMMIT, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/widget/pull/42" }),
    recordPreRefAbort: async () => receipt({ state: "pending", commitSha: null }),
    recordIntent: async () => true,
    renewClaim: async () => true,
    recordAmbiguous: async () => receipt({ state: "reconcile_required" }),
    recordAbsent: async () => receipt({ state: "pending" }),
    ...overrides,
  };
}

async function reconcilePullCandidate(candidate: Record<string, unknown>) {
  const ambiguous = receipt({ state: "reconcile_required", commitSha: COMMIT });
  const responses = [
    Response.json({ object: { sha: COMMIT } }),
    Response.json({ sha: COMMIT }),
    Response.json([candidate]),
  ];
  let successCalls = 0;
  const releasedErrors: string[] = [];
  const execute = createGithubPublicationToolExecutor(dependencies({
    ensureReceipt: async () => ({ row: ambiguous, created: false }),
    claimReconcile: async () => ({ receipt: ambiguous, claimToken: "reconcile", mode: "reconcile" }),
    fetch: async () => responses.shift() ?? Response.json({}, { status: 500 }),
    recordSuccess: async () => { successCalls += 1; return receipt({ state: "published" }); },
    recordAmbiguous: async (input) => {
      releasedErrors.push(input.error);
      return receipt({ state: "reconcile_required", claimToken: null, claimExpiresAt: null, lastError: input.error });
    },
  }));
  const result = await execute(claims, "github_pull_request_publish", {
    changeSetId: "change-a",
    idempotencyKey: "key-a",
    headBranch: "useagent/readme",
    commitMessage: "Update README",
    pullRequestTitle: "Update README",
    pullRequestBody: "Prepared by useAgent",
    draft: false,
  });
  return { result, successCalls, releasedErrors };
}

describe("GitHub publication gateway workflow", () => {
  test("prepare freezes server-resolved base SHA and content-addressed payload for the live binding", async () => {
    const frozenInputs: Array<Parameters<PublicationToolDependencies["freeze"]>[0]> = [];
    const stored: Array<{ key: string; bytes: Uint8Array }> = [];
    const execute = createGithubPublicationToolExecutor(dependencies({
      putPayload: async (key, bytes) => { stored.push({ key, bytes }); },
      freeze: async (input) => {
        frozenInputs.push(input);
        return { row: changeSet({ baseSha: input.baseSha, payloadStorageKey: input.payloadStorageKey }), created: true };
      },
    }));
    const result = await execute(claims, "github_changeset_prepare", {
      repository: "acme/widget",
      targetBranch: "main",
      bundlePath: "/root/work/github-change-bundle.json",
    });

    expect(result.isError).not.toBe(true);
    expect(frozenInputs[0]).toMatchObject({ repoFullName: "acme/widget", baseRef: "main", baseSha: SHA });
    expect(stored[0]?.key).toBe(frozenInputs[0]?.payloadSha256);
    expect(stored[0]?.bytes.byteLength).toBeGreaterThan(0);
  });

  test("publish is approval-gated by exact arguments and returns an existing idempotent receipt without republishing", async () => {
    expect(gatewayToolRequiresApproval("github_pull_request_publish")).toBe(true);
    expect(advertisedGatewayToolDescriptor("github_pull_request_publish")?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["approvalCapability", "idempotencyKey", "changeSetId"]),
    });
    const exact = { changeSetId: "change-a", idempotencyKey: "key-a", headBranch: "useagent/readme" };
    expect(approvalArgumentsHash(exact)).not.toBe(approvalArgumentsHash({ ...exact, headBranch: "other" }));
    const bypass = await executeGithubToolLocal(claims, "github_pull_request_publish", {
      ...exact,
      commitMessage: "Update README",
      pullRequestTitle: "Update README",
      pullRequestBody: "Prepared by useAgent",
      draft: false,
    });
    expect(bypass.structuredContent).toEqual({ error: "approval_required" });

    let publishCalls = 0;
    const published = receipt({
      state: "published",
      commitSha: COMMIT,
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/acme/widget/pull/42",
    });
    const execute = createGithubPublicationToolExecutor(dependencies({
      ensureReceipt: async () => ({ row: published, created: false }),
      publish: async () => { publishCalls += 1; throw new Error("must not publish"); },
    }));
    const result = await execute(claims, "github_pull_request_publish", {
      ...exact,
      commitMessage: "Update README",
      pullRequestTitle: "Update README",
      pullRequestBody: "Prepared by useAgent",
      draft: false,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.publication).toMatchObject({ state: "published", pull_request_number: 42 });
    expect(publishCalls).toBe(0);
  });

  test("an ambiguous publication deterministically reconciles an absent branch back to pending", async () => {
    const ambiguous = receipt({ state: "reconcile_required", commitSha: COMMIT });
    let absentRecorded = false;
    let fetchCount = 0;
    const execute = createGithubPublicationToolExecutor(dependencies({
      ensureReceipt: async () => ({ row: ambiguous, created: false }),
      claimReconcile: async () => ({ receipt: ambiguous, claimToken: "reconcile", mode: "reconcile" }),
      fetch: async () => {
        fetchCount += 1;
        return fetchCount < 3
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json([]);
      },
      recordAbsent: async () => { absentRecorded = true; return receipt({ state: "pending" }); },
    }));
    const result = await execute(claims, "github_pull_request_publish", {
      changeSetId: "change-a",
      idempotencyKey: "key-a",
      headBranch: "useagent/readme",
      commitMessage: "Update README",
      pullRequestTitle: "Update README",
      pullRequestBody: "Prepared by useAgent",
      draft: false,
    });
    expect(absentRecorded).toBe(true);
    expect(fetchCount).toBe(3);
    expect(result.structuredContent).toMatchObject({ reconciliation: "absent", publication: { state: "pending" } });
  });

  test("an expired publishing lease with no durable intent resets as a pre-ref abort", async () => {
    const crashed = receipt({ state: "publishing", commitSha: null });
    const aborts: string[] = [];
    const execute = createGithubPublicationToolExecutor(dependencies({
      ensureReceipt: async () => ({ row: crashed, created: false }),
      claimReconcile: async () => ({
        receipt: { ...crashed, state: "reconcile_required" },
        claimToken: "reconcile",
        mode: "reconcile",
      }),
      recordPreRefAbort: async (input) => {
        aborts.push(input.error ?? "");
        return receipt({ state: "pending", commitSha: null, claimToken: null, claimExpiresAt: null });
      },
    }));
    const result = await execute(claims, "github_pull_request_publish", {
      changeSetId: "change-a",
      idempotencyKey: "key-a",
      headBranch: "useagent/readme",
      commitMessage: "Update README",
      pullRequestTitle: "Update README",
      pullRequestBody: "Prepared by useAgent",
      draft: false,
    });
    expect(aborts).toEqual(["pre_ref_abort:missing_intended_commit"]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      reconciliation: "pre_ref_aborted",
      change_set_state: "frozen",
      publication: { state: "pending", commit_sha: null },
    });
  });

  test("reconciliation never certifies an unrelated branch SHA and releases its claim", async () => {
    const ambiguous = receipt({ state: "reconcile_required", commitSha: COMMIT });
    const responses = [
      Response.json({ object: { sha: "9".repeat(40) } }),
      Response.json({ sha: COMMIT }),
      Response.json([]),
    ];
    const releasedErrors: string[] = [];
    let successCalls = 0;
    const execute = createGithubPublicationToolExecutor(dependencies({
      ensureReceipt: async () => ({ row: ambiguous, created: false }),
      claimReconcile: async () => ({ receipt: ambiguous, claimToken: "reconcile", mode: "reconcile" }),
      fetch: async () => responses.shift() ?? Response.json({}, { status: 500 }),
      recordSuccess: async () => { successCalls += 1; return receipt({ state: "published" }); },
      recordAmbiguous: async (input) => {
        releasedErrors.push(input.error);
        return receipt({ state: "reconcile_required", claimToken: null, claimExpiresAt: null, lastError: input.error });
      },
    }));
    const result = await execute(claims, "github_pull_request_publish", {
      changeSetId: "change-a",
      idempotencyKey: "key-a",
      headBranch: "useagent/readme",
      commitMessage: "Update README",
      pullRequestTitle: "Update README",
      pullRequestBody: "Prepared by useAgent",
      draft: false,
    });
    expect(successCalls).toBe(0);
    expect(releasedErrors).toEqual(["reconcile_head_sha_mismatch"]);
    expect(result.structuredContent).toMatchObject({
      reconciliation: "head_sha_mismatch",
      publication: { state: "reconcile_required" },
    });
  });

  test("reconciliation rejects the intended SHA from a different head branch", async () => {
    const outcome = await reconcilePullCandidate({
      number: 42,
      html_url: "https://github.com/acme/widget/pull/42",
      head: {
        sha: COMMIT,
        ref: "attacker/same-commit",
        repo: { full_name: "acme/widget" },
      },
      base: { ref: "main" },
    });
    expect(outcome.successCalls).toBe(0);
    expect(outcome.releasedErrors).toEqual(["reconcile_head_without_pull_request"]);
    expect(outcome.result.structuredContent?.publication).toMatchObject({
      state: "reconcile_required",
    });
  });

  test("reconciliation rejects the intended SHA from a fork", async () => {
    const outcome = await reconcilePullCandidate({
      number: 43,
      html_url: "https://github.com/acme/widget/pull/43",
      head: {
        sha: COMMIT,
        ref: "useagent/readme",
        repo: { full_name: "attacker/widget" },
      },
      base: { ref: "main" },
    });
    expect(outcome.successCalls).toBe(0);
    expect(outcome.releasedErrors).toEqual(["reconcile_head_without_pull_request"]);
    expect(outcome.result.structuredContent?.publication).toMatchObject({
      state: "reconcile_required",
    });
  });

  test("a reconciliation transport failure releases the durable claim", async () => {
    const ambiguous = receipt({ state: "reconcile_required", commitSha: COMMIT });
    const releasedErrors: string[] = [];
    const execute = createGithubPublicationToolExecutor(dependencies({
      ensureReceipt: async () => ({ row: ambiguous, created: false }),
      claimReconcile: async () => ({ receipt: ambiguous, claimToken: "reconcile", mode: "reconcile" }),
      fetch: async () => { throw new Error("network unavailable"); },
      recordAmbiguous: async (input) => {
        releasedErrors.push(input.error);
        return receipt({ state: "reconcile_required", claimToken: null, claimExpiresAt: null, lastError: input.error });
      },
    }));
    const result = await execute(claims, "github_pull_request_publish", {
      changeSetId: "change-a",
      idempotencyKey: "key-a",
      headBranch: "useagent/readme",
      commitMessage: "Update README",
      pullRequestTitle: "Update README",
      pullRequestBody: "Prepared by useAgent",
      draft: false,
    });
    expect(result.isError).toBe(true);
    expect(releasedErrors).toEqual(["reconcile_failed:network unavailable"]);
    expect(result.structuredContent?.publication).toMatchObject({
      state: "reconcile_required",
      last_error: "reconcile_failed:network unavailable",
    });
  });

  test("reconciliation never reports published when the success claim is stale", async () => {
    const ambiguous = receipt({ state: "reconcile_required", commitSha: COMMIT });
    const responses = [
      Response.json({ object: { sha: COMMIT } }),
      Response.json({ sha: COMMIT }),
      Response.json([{
        number: 42,
        html_url: "https://github.com/acme/widget/pull/42",
        head: {
          sha: COMMIT,
          ref: "useagent/readme",
          repo: { full_name: "acme/widget" },
        },
        base: { ref: "main" },
      }]),
    ];
    const execute = createGithubPublicationToolExecutor(dependencies({
      ensureReceipt: async () => ({ row: ambiguous, created: false }),
      claimReconcile: async () => ({ receipt: ambiguous, claimToken: "stale", mode: "reconcile" }),
      fetch: async () => responses.shift() ?? Response.json({}, { status: 500 }),
      recordSuccess: async () => null,
    }));
    const result = await execute(claims, "github_pull_request_publish", {
      changeSetId: "change-a",
      idempotencyKey: "key-a",
      headBranch: "useagent/readme",
      commitMessage: "Update README",
      pullRequestTitle: "Update README",
      pullRequestBody: "Prepared by useAgent",
      draft: false,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ reconciliation: "lease_lost" });
    expect(result.content[0]?.text).not.toContain("Reconciled published");
  });

  test("reconciliation never reports retry-safe absence when the absence claim is stale", async () => {
    const ambiguous = receipt({ state: "reconcile_required", commitSha: COMMIT });
    const responses = [
      Response.json({ message: "Not Found" }, { status: 404 }),
      Response.json({ message: "Not Found" }, { status: 404 }),
      Response.json([]),
    ];
    const execute = createGithubPublicationToolExecutor(dependencies({
      ensureReceipt: async () => ({ row: ambiguous, created: false }),
      claimReconcile: async () => ({ receipt: ambiguous, claimToken: "stale", mode: "reconcile" }),
      fetch: async () => responses.shift() ?? Response.json({}, { status: 500 }),
      recordAbsent: async () => null,
    }));
    const result = await execute(claims, "github_pull_request_publish", {
      changeSetId: "change-a",
      idempotencyKey: "key-a",
      headBranch: "useagent/readme",
      commitMessage: "Update README",
      pullRequestTitle: "Update README",
      pullRequestBody: "Prepared by useAgent",
      draft: false,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ reconciliation: "lease_lost" });
    expect(result.content[0]?.text).not.toContain("safe to retry");
  });

  test("publish uses the durable claim and persists the bounded publisher receipt", async () => {
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      files: [{ path: "README.md", mode: "100644", contentBase64: "aGk=" }],
    }));
    const digest = createHash("sha256").update(payload).digest("hex");
    const row = changeSet({
      payloadStorageKey: digest,
      payloadSha256: digest,
      payloadSizeBytes: payload.byteLength,
      manifest: {
        version: 1,
        files: [{
          path: "README.md",
          action: "modify",
          sha256: createHash("sha256").update("hi").digest("hex"),
          sizeBytes: 2,
          mode: "100644",
        }],
      },
    });
    const persistedClaims: string[] = [];
    const intendedCommits: string[] = [];
    let renewals = 0;
    const execute = createGithubPublicationToolExecutor(dependencies({
      getChangeSet: async () => row,
      readPayload: async () => payload,
      recordSuccess: async (input) => {
        persistedClaims.push(input.claimToken);
        return receipt({
          state: "published",
          commitSha: input.commitSha,
          pullRequestNumber: input.pullRequestNumber ?? null,
          pullRequestUrl: input.pullRequestUrl ?? null,
        });
      },
      recordIntent: async (input) => { intendedCommits.push(input.commitSha); return true; },
      renewClaim: async () => { renewals += 1; return true; },
      publish: async (_input, publisherDeps) => {
        await publisherDeps.assertLease?.();
        await publisherDeps.recordIntent?.(COMMIT);
        return {
          repository: "acme/widget",
          targetBranch: "main",
          headBranch: "useagent/readme",
          baseSha: SHA,
          treeSha: "1".repeat(40),
          commitSha: COMMIT,
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.com/acme/widget/pull/42",
        };
      },
    }));
    const result = await execute(claims, "github_pull_request_publish", {
      changeSetId: "change-a",
      idempotencyKey: "key-a",
      headBranch: "useagent/readme",
      commitMessage: "Update README",
      pullRequestTitle: "Update README",
      pullRequestBody: "Prepared by useAgent",
      draft: false,
    });
    expect(result.isError).not.toBe(true);
    expect(persistedClaims).toEqual(["claim"]);
    expect(intendedCommits).toEqual([COMMIT]);
    expect(renewals).toBeGreaterThan(0);
    expect(result.structuredContent?.publication).toMatchObject({
      state: "published",
      pull_request_number: 42,
    });
  });

  test("a proven pre-ref lease failure resets pending and clears commit intent for retry", async () => {
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      files: [{ path: "README.md", mode: "100644", contentBase64: "aGk=" }],
    }));
    const digest = createHash("sha256").update(payload).digest("hex");
    const row = changeSet({
      payloadStorageKey: digest,
      payloadSha256: digest,
      payloadSizeBytes: payload.byteLength,
      manifest: {
        version: 1,
        files: [{
          path: "README.md",
          action: "modify",
          sha256: createHash("sha256").update("hi").digest("hex"),
          sizeBytes: 2,
          mode: "100644",
        }],
      },
    });
    const aborts: string[] = [];
    const execute = createGithubPublicationToolExecutor(dependencies({
      getChangeSet: async () => row,
      readPayload: async () => payload,
      publish: async () => {
        throw new GitHubPublicationError({
          message: "GitHub publication lease was lost during create_head_ref",
          stage: "create_head_ref",
          reconcileRequired: false,
          repository: "acme/widget",
          headBranch: "useagent/readme",
          commitSha: COMMIT,
          headRefState: "not_created",
        });
      },
      recordPreRefAbort: async (input) => {
        aborts.push(input.error ?? "");
        return receipt({ state: "pending", commitSha: null, claimToken: null, claimExpiresAt: null });
      },
    }));
    const result = await execute(claims, "github_pull_request_publish", {
      changeSetId: "change-a",
      idempotencyKey: "key-a",
      headBranch: "useagent/readme",
      commitMessage: "Update README",
      pullRequestTitle: "Update README",
      pullRequestBody: "Prepared by useAgent",
      draft: false,
    });
    expect(result.isError).toBe(true);
    expect(aborts).toEqual([
      "pre_ref_abort:GitHub publication lease was lost during create_head_ref",
    ]);
    expect(result.structuredContent?.publication).toMatchObject({
      state: "pending",
      commit_sha: null,
    });
  });

  test("status returns durable PR metadata and rejects a change set owned by another run", async () => {
    const published = receipt({
      state: "published",
      commitSha: COMMIT,
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/acme/widget/pull/42",
    });
    const execute = createGithubPublicationToolExecutor(dependencies({ getReceipt: async () => published }));
    const status = await execute(claims, "github_publication_status", { changeSetId: "change-a" });
    expect(status.structuredContent?.publication).toMatchObject({
      state: "published",
      commit_sha: COMMIT,
      pull_request_url: "https://github.com/acme/widget/pull/42",
    });

    const denied = createGithubPublicationToolExecutor(dependencies({
      getChangeSet: async () => changeSet({ runId: "run-b" }),
    }));
    const deniedStatus = await denied(claims, "github_publication_status", { changeSetId: "change-a" });
    expect(deniedStatus.isError).toBe(true);
    expect(deniedStatus.content[0]?.text).toContain("not found for this run");
  });
});
