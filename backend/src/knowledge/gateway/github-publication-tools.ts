import { createHash } from "node:crypto";
import { posix } from "node:path";
import { artifactStorage } from "../../artifacts/storage";
import type {
  GitHubChangeManifest,
  GitHubChangeManifestFile,
  GitHubFileMode,
} from "../../db/schema";
import { resolveGithubPublicationToken } from "../../github/auth";
import {
  claimGitHubPublicationReceipt,
  claimGitHubPublicationReconciliation,
  ensureGitHubPublicationReceipt,
  freezeGitHubChangeSet,
  getGitHubChangeSetForOrg,
  getGitHubPublicationReceiptForChangeSet,
  recordGitHubPublicationAbsentAfterReconcile,
  recordGitHubPublicationAmbiguous,
  recordGitHubPublicationIntent,
  recordGitHubPublicationPreRefAbort,
  recordGitHubPublicationSuccess,
  renewGitHubPublicationClaim,
  type ClaimedGitHubPublicationReceipt,
  type GitHubChangeSetRecord,
  type GitHubPublicationReceiptRecord,
} from "../../github/publication-repo";
import {
  GitHubPublicationError,
  publishFrozenGitHubChange,
  type FrozenGitHubPayload,
} from "../../github/publisher";
import { getRunForOrg } from "../../runs/repo";
import type { GatewayToolDescriptor } from "./descriptor";
import { hasGitHubRepositoryCheckoutIntent } from "../../resources/public-github";
import { isProtectedInjectedSecretPath } from "../../secrets/inject";
import { downloadSandboxFile, resolveSandboxFilePath } from "../../slack/sandbox-file";
import { errorResult, textResult } from "./tool-results";
import type { ToolCallResult } from "./tools";
import type { ToolTokenClaims } from "./token";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const CHANGE_SET_TTL_MS = 60 * 60 * 1_000;
const GITHUB_API = "https://api.github.com";
type PublicationFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const GITHUB_PUBLICATION_TOOLS: readonly GatewayToolDescriptor[] = [
  {
    name: "github_changeset_prepare",
    description:
      "Freeze a bounded, immutable GitHub change set on the trusted backend. The repository must be bound to the live run. The backend resolves and pins the target branch SHA; credentials never enter the sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string", description: "Bound owner/name repository." },
        targetBranch: { type: "string", description: "Base branch to pin." },
        bundlePath: {
          type: "string",
          description:
            "Canonical /root/work path to a JSON bundle shaped as {version:1,changes:[{path,action,contentBase64?,mode?,previousPath?}]} in the live sandbox. The trusted backend streams and bounds this file directly; large file bytes never cross the public MCP request body.",
        },
        title: { type: "string" },
        summary: { type: "string" },
      },
      required: ["repository", "targetBranch", "bundlePath"],
      additionalProperties: false,
    },
  },
  {
    name: "github_pull_request_publish",
    description:
      "Publish one frozen change set as a new branch and pull request. Requires a one-shot human approval bound to every exact argument and an idempotency key. Ambiguous GitHub outcomes are reconciled instead of blindly retried.",
    inputSchema: {
      type: "object",
      properties: {
        changeSetId: { type: "string" },
        idempotencyKey: { type: "string" },
        headBranch: { type: "string" },
        commitMessage: { type: "string" },
        pullRequestTitle: { type: "string" },
        pullRequestBody: { type: "string" },
        draft: { type: "boolean" },
      },
      required: [
        "changeSetId",
        "idempotencyKey",
        "headBranch",
        "commitMessage",
        "pullRequestTitle",
        "pullRequestBody",
        "draft",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "github_publication_status",
    description:
      "Read durable state and pull-request metadata for a GitHub change set owned by this run.",
    inputSchema: {
      type: "object",
      properties: { changeSetId: { type: "string" } },
      required: ["changeSetId"],
      additionalProperties: false,
    },
  },
];

export const GITHUB_PUBLICATION_TOOL_NAMES = new Set(
  GITHUB_PUBLICATION_TOOLS.map((tool) => tool.name),
);

export interface PublicationToolDependencies {
  readonly getRun: typeof getRunForOrg;
  readonly resolveToken: typeof resolveGithubPublicationToken;
  readonly fetch: PublicationFetch;
  readonly putPayload: (key: string, bytes: Uint8Array) => Promise<void>;
  readonly readSandboxBundle: (sandboxId: string, path: string) => Promise<Uint8Array>;
  readonly readPayload: (key: string) => Promise<Uint8Array>;
  readonly freeze: typeof freezeGitHubChangeSet;
  readonly getChangeSet: typeof getGitHubChangeSetForOrg;
  readonly getReceipt: typeof getGitHubPublicationReceiptForChangeSet;
  readonly ensureReceipt: typeof ensureGitHubPublicationReceipt;
  readonly claimPublish: typeof claimGitHubPublicationReceipt;
  readonly claimReconcile: typeof claimGitHubPublicationReconciliation;
  readonly publish: typeof publishFrozenGitHubChange;
  readonly recordSuccess: typeof recordGitHubPublicationSuccess;
  readonly recordPreRefAbort: typeof recordGitHubPublicationPreRefAbort;
  readonly recordIntent: typeof recordGitHubPublicationIntent;
  readonly renewClaim: typeof renewGitHubPublicationClaim;
  readonly recordAmbiguous: typeof recordGitHubPublicationAmbiguous;
  readonly recordAbsent: typeof recordGitHubPublicationAbsentAfterReconcile;
}

const productionDependencies: PublicationToolDependencies = {
  getRun: getRunForOrg,
  resolveToken: resolveGithubPublicationToken,
  fetch,
  putPayload: (key, bytes) => artifactStorage().put(key, bytes),
  readSandboxBundle: async (sandboxId, path) => {
    const requested = path.trim();
    if (
      !requested ||
      !posix.isAbsolute(requested) ||
      posix.normalize(requested) !== requested ||
      !requested.startsWith("/root/work/") ||
      isProtectedInjectedSecretPath(requested)
    ) {
      throw new Error("bundlePath must be a canonical non-secret path under /root/work");
    }
    const resolved = await resolveSandboxFilePath(sandboxId, requested);
    if (resolved !== requested || !resolved.startsWith("/root/work/") || isProtectedInjectedSecretPath(resolved)) {
      throw new Error("bundlePath must not traverse or use a symlink outside /root/work");
    }
    return (await downloadSandboxFile(sandboxId, resolved, MAX_BUNDLE_BYTES)).bytes;
  },
  readPayload: (key) => artifactStorage().read(key),
  freeze: freezeGitHubChangeSet,
  getChangeSet: getGitHubChangeSetForOrg,
  getReceipt: getGitHubPublicationReceiptForChangeSet,
  ensureReceipt: ensureGitHubPublicationReceipt,
  claimPublish: claimGitHubPublicationReceipt,
  claimReconcile: claimGitHubPublicationReconciliation,
  publish: publishFrozenGitHubChange,
  recordSuccess: recordGitHubPublicationSuccess,
  recordPreRefAbort: recordGitHubPublicationPreRefAbort,
  recordIntent: recordGitHubPublicationIntent,
  renewClaim: renewGitHubPublicationClaim,
  recordAmbiguous: recordGitHubPublicationAmbiguous,
  recordAbsent: recordGitHubPublicationAbsentAfterReconcile,
};

function requiredString(value: unknown, name: string, max = 4_096): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function repositoryPath(value: unknown, name = "path"): string {
  const path = requiredString(value, name);
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`${name} must be repository-relative`);
  }
  return path;
}

function branchName(value: unknown, name: string): string {
  const branch = requiredString(value, name, 255);
  if (
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[~^:?*[\\\s]/u.test(branch)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return branch;
}

function decodeBase64(value: unknown, path: string): Uint8Array {
  const encoded = typeof value === "string" ? value : "";
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new Error(`contentBase64 for ${path} is invalid`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${path} exceeds the file-size limit`);
  if (bytes.toString("base64") !== encoded) throw new Error(`contentBase64 for ${path} is invalid`);
  return bytes;
}

function frozenPayload(args: Record<string, unknown>): {
  manifest: GitHubChangeManifest;
  payload: FrozenGitHubPayload;
  storedBytes: Uint8Array;
} {
  if (!Array.isArray(args.changes) || args.changes.length < 1 || args.changes.length > MAX_FILES) {
    throw new Error(`changes must contain 1-${MAX_FILES} files`);
  }
  const manifestFiles: GitHubChangeManifestFile[] = [];
  const payloadFiles: Array<{ path: string; mode: GitHubFileMode; content: Uint8Array }> = [];
  const seen = new Set<string>();
  for (const raw of args.changes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("change is invalid");
    const change = raw as Record<string, unknown>;
    const path = repositoryPath(change.path);
    if (seen.has(path)) throw new Error(`changes repeat ${path}`);
    seen.add(path);
    const action = change.action;
    if (action !== "add" && action !== "modify" && action !== "delete" && action !== "rename") {
      throw new Error(`action for ${path} is invalid`);
    }
    const previousPath = action === "rename"
      ? repositoryPath(change.previousPath, "previousPath")
      : undefined;
    if (action === "delete") {
      manifestFiles.push({ path, action });
      continue;
    }
    const mode = (change.mode ?? "100644") as GitHubFileMode;
    if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
      throw new Error(`mode for ${path} is invalid`);
    }
    const content = decodeBase64(change.contentBase64, path);
    manifestFiles.push({
      path,
      action,
      sha256: sha256(content),
      sizeBytes: content.byteLength,
      mode,
      ...(previousPath ? { previousPath } : {}),
    });
    payloadFiles.push({ path, mode, content });
  }
  const manifest: GitHubChangeManifest = {
    version: 1,
    files: manifestFiles,
    ...(args.title ? { title: requiredString(args.title, "title", 255) } : {}),
    ...(args.summary ? { summary: requiredString(args.summary, "summary", 2_000) } : {}),
  };
  const storedBytes = Buffer.from(JSON.stringify({
    version: 1,
    files: payloadFiles.map((file) => ({
      path: file.path,
      mode: file.mode,
      contentBase64: Buffer.from(file.content).toString("base64"),
    })),
  }));
  if (storedBytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error("github payload exceeds the total size limit");
  }
  return { manifest, payload: { version: 1, files: payloadFiles }, storedBytes };
}

function decodeStoredPayload(bytes: Uint8Array): FrozenGitHubPayload {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
    version?: unknown;
    files?: unknown;
  };
  if (parsed.version !== 1 || !Array.isArray(parsed.files)) throw new Error("frozen payload is invalid");
  return {
    version: 1,
    files: parsed.files.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("frozen payload file is invalid");
      const file = raw as Record<string, unknown>;
      const mode = file.mode as GitHubFileMode;
      if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
        throw new Error("frozen payload mode is invalid");
      }
      const path = requiredString(file.path, "frozen payload path");
      return { path, mode, content: decodeBase64(file.contentBase64, path) };
    }),
  };
}

function ownedChangeSet(
  claims: ToolTokenClaims,
  changeSet: GitHubChangeSetRecord | null,
): GitHubChangeSetRecord {
  if (
    !changeSet ||
    changeSet.runId !== claims.runId ||
    changeSet.threadId !== claims.threadId ||
    changeSet.userId !== claims.userId
  ) {
    throw new Error("github change set not found for this run");
  }
  return changeSet;
}

function statusProjection(
  changeSet: GitHubChangeSetRecord,
  receipt: GitHubPublicationReceiptRecord | null,
  reconciliation?: string,
): Record<string, unknown> {
  return {
    change_set_id: changeSet.id,
    change_set_state: changeSet.state,
    repository: changeSet.repoFullName,
    target_branch: changeSet.baseRef,
    base_sha: changeSet.baseSha,
    expires_at: changeSet.expiresAt.toISOString(),
    publication: receipt
      ? {
          receipt_id: receipt.id,
          state: receipt.state,
          head_branch: receipt.headBranch,
          commit_sha: receipt.commitSha,
          pull_request_number: receipt.pullRequestNumber,
          pull_request_url: receipt.pullRequestUrl,
          attempt_count: receipt.attemptCount,
          last_error: receipt.lastError,
        }
      : null,
    ...(reconciliation ? { reconciliation } : {}),
  };
}

async function githubJson(
  deps: PublicationToolDependencies,
  token: string,
  path: string,
): Promise<{ response: Response; body: unknown }> {
  const response = await deps.fetch(`${GITHUB_API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "useagent",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  return { response, body: await response.json().catch(() => null) };
}

async function prepare(
  deps: PublicationToolDependencies,
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const run = await deps.getRun(claims.orgId, claims.runId);
  if (!run || run.threadId !== claims.threadId || run.userId !== claims.userId) {
    throw new Error("live run identity is no longer valid");
  }
  if (!run.sandboxId) throw new Error("the live run has no attached sandbox");
  const repository = requiredString(args.repository, "repository", 255);
  const targetBranch = branchName(args.targetBranch, "targetBranch");
  const binding = run.resolvedResources.find(
    (resource) =>
      resource.provider === "github" &&
      resource.locator.type === "github.repository" &&
      resource.locator.repository.toLowerCase() === repository.toLowerCase() &&
      resource.capabilities.includes("code.checkout") &&
      hasGitHubRepositoryCheckoutIntent(resource),
  );
  if (!binding) throw new Error("repository is not an immutable checkout binding of this run");
  if (binding.locator.type !== "github.repository") throw new Error("repository binding is invalid");
  if (binding.locator.revision && binding.locator.revision !== targetBranch) {
    throw new Error("targetBranch does not match the run's immutable repository binding");
  }

  const token = await deps.resolveToken(binding.locator.repository, claims.orgId);
  const [owner, name] = binding.locator.repository.split("/");
  const target = await githubJson(
    deps,
    token,
    `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/git/ref/heads/${encodeURIComponent(targetBranch)}`,
  );
  if (!target.response.ok) throw new Error(`GitHub target branch lookup failed: HTTP ${target.response.status}`);
  const baseSha = (target.body as { object?: { sha?: unknown } } | null)?.object?.sha;
  if (typeof baseSha !== "string" || !/^[0-9a-f]{40}$/u.test(baseSha)) {
    throw new Error("GitHub target branch returned an invalid SHA");
  }

  const bundleBytes = await deps.readSandboxBundle(
    run.sandboxId,
    requiredString(args.bundlePath, "bundlePath"),
  );
  let bundle: unknown;
  try {
    bundle = JSON.parse(Buffer.from(bundleBytes).toString("utf8"));
  } catch {
    throw new Error("GitHub change bundle is not valid JSON");
  }
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("GitHub change bundle is invalid");
  }
  const bundleRecord = bundle as Record<string, unknown>;
  if (bundleRecord.version !== 1) throw new Error("GitHub change bundle version is invalid");
  const frozen = frozenPayload({
    changes: bundleRecord.changes,
    ...(args.title ? { title: args.title } : {}),
    ...(args.summary ? { summary: args.summary } : {}),
  });
  const payloadSha = sha256(frozen.storedBytes);
  await deps.putPayload(payloadSha, frozen.storedBytes);
  const result = await deps.freeze({
    orgId: claims.orgId,
    userId: claims.userId,
    runId: claims.runId,
    repoFullName: binding.locator.repository,
    baseRef: targetBranch,
    baseSha,
    manifest: frozen.manifest,
    payloadStorageKey: payloadSha,
    payloadSha256: payloadSha,
    payloadSizeBytes: frozen.storedBytes.byteLength,
    expiresAt: new Date(Date.now() + CHANGE_SET_TTL_MS),
  });
  return textResult(
    `Frozen GitHub change set ${result.row.id} at ${result.row.repoFullName}@${result.row.baseSha}.`,
    { ...statusProjection(result.row, null), already_prepared: !result.created },
  );
}

async function reconcile(
  deps: PublicationToolDependencies,
  claims: ToolTokenClaims,
  changeSet: GitHubChangeSetRecord,
  claim: ClaimedGitHubPublicationReceipt,
): Promise<ToolCallResult> {
  const intendedCommitSha = claim.receipt.commitSha;
  if (!intendedCommitSha || !/^[0-9a-f]{40}$/u.test(intendedCommitSha)) {
    const receipt = await deps.recordPreRefAbort({
      orgId: claims.orgId,
      receiptId: claim.receipt.id,
      claimToken: claim.claimToken,
      error: "pre_ref_abort:missing_intended_commit",
    });
    if (!receipt) {
      return errorResult(
        "GitHub publication lease was lost before the pre-ref abort could be persisted.",
        { reconciliation: "lease_lost" },
      );
    }
    return textResult(
      "No commit intent was persisted, proving no branch attempt began; the publication is reset for a newly approved retry.",
      statusProjection({ ...changeSet, state: "frozen" }, receipt, "pre_ref_aborted"),
    );
  }
  const renew = async () => {
    if (!(await deps.renewClaim({
      orgId: claims.orgId,
      receiptId: claim.receipt.id,
      claimToken: claim.claimToken,
    }))) {
      throw new Error("GitHub publication reconciliation lease was lost");
    }
  };
  const token = await deps.resolveToken(changeSet.repoFullName, claims.orgId);
  const [owner, name] = changeSet.repoFullName.split("/");
  const repoPath = `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
  await renew();
  const ref = await githubJson(
    deps,
    token,
    `${repoPath}/git/ref/heads/${encodeURIComponent(claim.receipt.headBranch)}`,
  );
  await renew();
  const commit = await githubJson(
    deps,
    token,
    `${repoPath}/git/commits/${encodeURIComponent(intendedCommitSha)}`,
  );
  await renew();
  const pulls = await githubJson(
    deps,
    token,
    `${repoPath}/commits/${encodeURIComponent(intendedCommitSha)}/pulls?per_page=10`,
  );
  const pull = Array.isArray(pulls.body)
    ? (pulls.body as Array<{
        number?: unknown;
        html_url?: unknown;
        head?: {
          sha?: unknown;
          ref?: unknown;
          repo?: { full_name?: unknown } | null;
        };
        base?: { ref?: unknown };
      }>).find(
        (candidate) =>
          candidate.head?.sha === intendedCommitSha &&
          candidate.head.ref === claim.receipt.headBranch &&
          typeof candidate.head.repo?.full_name === "string" &&
          candidate.head.repo.full_name.toLowerCase() ===
            changeSet.repoFullName.toLowerCase() &&
          candidate.base?.ref === changeSet.baseRef,
      )
    : undefined;
  if (
    pulls.response.ok &&
    pull &&
    Number.isSafeInteger(pull.number) &&
    typeof pull.html_url === "string"
  ) {
    const receipt = await deps.recordSuccess({
      orgId: claims.orgId,
      receiptId: claim.receipt.id,
      claimToken: claim.claimToken,
      commitSha: intendedCommitSha,
      pullRequestNumber: pull.number as number,
      pullRequestUrl: pull.html_url,
    });
    if (!receipt) {
      return errorResult(
        "GitHub reconciliation lease was lost before publication success could be persisted.",
        { reconciliation: "lease_lost" },
      );
    }
    return textResult(`Reconciled published pull request ${pull.html_url}.`,
      statusProjection({ ...changeSet, state: "published" }, receipt, "published"));
  }

  const refSha = (ref.body as { object?: { sha?: unknown } } | null)?.object?.sha;
  const refAbsent = ref.response.status === 404;
  const commitKnown = commit.response.ok || commit.response.status === 404;
  if (
    refAbsent &&
    commitKnown &&
    pulls.response.ok &&
    Array.isArray(pulls.body) &&
    pulls.body.length === 0
  ) {
    const receipt = await deps.recordAbsent({
      orgId: claims.orgId,
      receiptId: claim.receipt.id,
      claimToken: claim.claimToken,
    });
    if (!receipt) {
      return errorResult(
        "GitHub reconciliation lease was lost before retry-safe absence could be persisted.",
        { reconciliation: "lease_lost" },
      );
    }
    return textResult(
      "The intended commit has no branch or pull request; the publication is safe to retry with a new approval.",
      statusProjection({ ...changeSet, state: "frozen" }, receipt, "absent"),
    );
  }

  let outcome = "unknown";
  if (ref.response.ok && refSha !== intendedCommitSha) outcome = "head_sha_mismatch";
  else if (ref.response.ok && refSha === intendedCommitSha && pulls.response.ok) {
    outcome = "head_without_pull_request";
  }
  const error = outcome === "unknown"
    ? `reconcile_unknown:ref=${ref.response.status},commit=${commit.response.status},pulls=${pulls.response.status}`
    : `reconcile_${outcome}`;
  const receipt = await deps.recordAmbiguous({
    orgId: claims.orgId,
    receiptId: claim.receipt.id,
    claimToken: claim.claimToken,
    error,
  });
  if (!receipt) {
    return errorResult("GitHub reconciliation lease was lost before the outcome could be persisted.", {
      reconciliation: "lease_lost",
    });
  }
  if (outcome === "unknown") {
    return textResult("GitHub reconciliation remains unresolved.",
      statusProjection(changeSet, receipt, "unknown"));
  }
  return textResult(
    outcome === "head_sha_mismatch"
      ? "The publication branch points to a different commit and was not certified."
      : "The intended publication branch exists but no matching pull request can be proven.",
    statusProjection(changeSet, receipt, outcome),
  );
}

async function publish(
  deps: PublicationToolDependencies,
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const changeSetId = requiredString(args.changeSetId, "changeSetId", 255);
  const changeSet = ownedChangeSet(
    claims,
    await deps.getChangeSet(claims.orgId, changeSetId),
  );
  const ensured = await deps.ensureReceipt({
    orgId: claims.orgId,
    changeSetId,
    idempotencyKey: requiredString(args.idempotencyKey, "idempotencyKey", 512),
    targetBranch: changeSet.baseRef,
    headBranch: branchName(args.headBranch, "headBranch"),
    draft: args.draft === true,
    commitMessage: requiredString(args.commitMessage, "commitMessage", 255),
    pullRequestTitle: requiredString(args.pullRequestTitle, "pullRequestTitle", 255),
    pullRequestBody: requiredString(args.pullRequestBody, "pullRequestBody", 64 * 1024),
  });
  if (ensured.row.state === "published") {
    return textResult("This idempotent publication is already complete.",
      statusProjection(changeSet, ensured.row));
  }
  if (ensured.row.state === "reconcile_required" || ensured.row.state === "publishing") {
    const claim = await deps.claimReconcile(claims.orgId, ensured.row.id);
    if (claim) {
      try {
        return await reconcile(deps, claims, changeSet, claim);
      } catch (error) {
        const message = error instanceof Error ? error.message : "GitHub reconciliation failed";
        const receipt = await deps.recordAmbiguous({
          orgId: claims.orgId,
          receiptId: claim.receipt.id,
          claimToken: claim.claimToken,
          error: `reconcile_failed:${message}`,
        });
        return errorResult(message, receipt
          ? statusProjection(changeSet, receipt, "unknown")
          : { reconciliation: "lease_lost" });
      }
    }
    const current = await deps.getReceipt(claims.orgId, changeSet.id);
    return textResult("Publication is already in progress.", statusProjection(changeSet, current));
  }
  const claim = await deps.claimPublish(claims.orgId, ensured.row.id);
  if (!claim) {
    const current = await deps.getReceipt(claims.orgId, changeSet.id);
    return textResult("Publication is already in progress or cannot currently be claimed.",
      statusProjection(changeSet, current));
  }
  let externalOutcomePossible = false;
  try {
    const bytes = await deps.readPayload(changeSet.payloadStorageKey);
    if (bytes.byteLength !== changeSet.payloadSizeBytes || sha256(bytes) !== changeSet.payloadSha256) {
      throw new Error("frozen payload integrity check failed");
    }
    const result = await deps.publish(
      {
        repository: changeSet.repoFullName,
        baseSha: changeSet.baseSha,
        targetBranch: claim.receipt.targetBranch,
        headBranch: claim.receipt.headBranch,
        manifest: changeSet.manifest,
        payload: decodeStoredPayload(bytes),
        commitMessage: claim.receipt.commitMessage,
        pullRequestTitle: claim.receipt.pullRequestTitle,
        pullRequestBody: claim.receipt.pullRequestBody,
        draft: claim.receipt.draft,
      },
      {
        resolveToken: (repository) => deps.resolveToken(repository, claims.orgId),
        fetch: deps.fetch,
        assertLease: async () => {
          if (!(await deps.renewClaim({
            orgId: claims.orgId,
            receiptId: claim.receipt.id,
            claimToken: claim.claimToken,
          }))) {
            throw new Error("GitHub publication lease was lost");
          }
        },
        recordIntent: async (commitSha) => {
          if (!(await deps.recordIntent({
            orgId: claims.orgId,
            receiptId: claim.receipt.id,
            claimToken: claim.claimToken,
            commitSha,
          }))) {
            throw new Error("GitHub publication lease was lost before commit intent persistence");
          }
        },
      },
    );
    externalOutcomePossible = true;
    const receipt = await deps.recordSuccess({
      orgId: claims.orgId,
      receiptId: claim.receipt.id,
      claimToken: claim.claimToken,
      commitSha: result.commitSha,
      pullRequestNumber: result.pullRequestNumber,
      pullRequestUrl: result.pullRequestUrl,
    });
    if (!receipt) throw new Error("publication claim expired before its receipt was persisted");
    return textResult(`Published pull request ${result.pullRequestUrl}.`,
      statusProjection({ ...changeSet, state: "published" }, receipt));
  } catch (error) {
    const message = error instanceof Error ? error.message : "github publication failed";
    const ambiguous = externalOutcomePossible ||
      (error instanceof GitHubPublicationError && error.reconcileRequired);
    const receipt = ambiguous
      ? await deps.recordAmbiguous({
          orgId: claims.orgId,
          receiptId: claim.receipt.id,
          claimToken: claim.claimToken,
          error: message,
          ...(error instanceof GitHubPublicationError && error.commitSha
            ? { commitSha: error.commitSha }
            : {}),
        })
      : await deps.recordPreRefAbort({
          orgId: claims.orgId,
          receiptId: claim.receipt.id,
          claimToken: claim.claimToken,
          error: `pre_ref_abort:${message}`,
        });
    return errorResult(message, statusProjection(changeSet, receipt));
  }
}

async function status(
  deps: PublicationToolDependencies,
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const changeSet = ownedChangeSet(
    claims,
    await deps.getChangeSet(
      claims.orgId,
      requiredString(args.changeSetId, "changeSetId", 255),
    ),
  );
  const receipt = await deps.getReceipt(claims.orgId, changeSet.id);
  return textResult(`GitHub publication state: ${receipt?.state ?? changeSet.state}.`,
    statusProjection(changeSet, receipt));
}

export function createGithubPublicationToolExecutor(
  deps: PublicationToolDependencies = productionDependencies,
) {
  return async (
    claims: ToolTokenClaims,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> => {
    try {
      if (name === "github_changeset_prepare") return await prepare(deps, claims, args);
      if (name === "github_pull_request_publish") return await publish(deps, claims, args);
      if (name === "github_publication_status") return await status(deps, claims, args);
      return errorResult(`Unknown GitHub publication tool: ${name}`);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "github publication operation failed");
    }
  };
}

export const executeGithubPublicationToolLocal = createGithubPublicationToolExecutor();
