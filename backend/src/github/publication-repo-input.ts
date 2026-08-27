import { createHash } from "node:crypto";
import {
  githubPublicationReceipts,
  runs,
  type GitHubChangeManifest,
} from "../db/schema.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFEST_FILES = 200;
export const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_PATH_LENGTH = 4_096;
export const MAX_LABEL_LENGTH = 255;
export const MAX_STORAGE_KEY_LENGTH = 1_024;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
export const MAX_ERROR_LENGTH = 500;
export const GITHUB_CHANGE_SET_MAX_TTL_MS = 24 * 60 * 60 * 1_000;

type GitHubPublicationReceiptRecord = typeof githubPublicationReceipts.$inferSelect;
type RunRepositoryBinding = Pick<typeof runs.$inferSelect, "resolvedResources">;

export class GitHubPublicationIdempotencyConflictError extends Error {
  constructor() {
    super("github publication idempotency key was reused for a different request");
    this.name = "GitHubPublicationIdempotencyConflictError";
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function boundedText(value: string, name: string, maxLength: number): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

export function sha(
  value: string,
  name: string,
  allowedLengths: readonly number[] = [64],
): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]+$/u.test(normalized) || !allowedLengths.includes(normalized.length)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

export function validateManifest(input: GitHubChangeManifest): {
  manifest: GitHubChangeManifest;
  serialized: string;
  sizeBytes: number;
} {
  if (input.version !== 1 || !Array.isArray(input.files)) {
    throw new Error("github change manifest is invalid");
  }
  if (input.files.length < 1 || input.files.length > MAX_MANIFEST_FILES) {
    throw new Error(`github change manifest must contain 1-${MAX_MANIFEST_FILES} files`);
  }

  const seen = new Set<string>();
  let totalFileBytes = 0;
  const files = input.files.map((file) => {
    const path = boundedText(file.path, "github change path", MAX_PATH_LENGTH);
    if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      throw new Error("github change path must be repository-relative");
    }
    if (seen.has(path)) throw new Error(`github change manifest repeats ${path}`);
    seen.add(path);

    if (!["add", "modify", "delete", "rename"].includes(file.action)) {
      throw new Error("github change action is invalid");
    }
    const previousPath = file.previousPath
      ? boundedText(file.previousPath, "github previous path", MAX_PATH_LENGTH)
      : undefined;
    if (
      previousPath &&
      (previousPath.startsWith("/") ||
        previousPath.includes("\\") ||
        previousPath.split("/").includes(".."))
    ) {
      throw new Error("github previous path must be repository-relative");
    }
    if (file.action === "rename" && !previousPath) {
      throw new Error("renamed github changes require previousPath");
    }
    if (
      file.sizeBytes !== undefined &&
      (!Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes < 0 ||
        file.sizeBytes > MAX_FILE_BYTES)
    ) {
      throw new Error("github change sizeBytes is invalid");
    }
    if (file.action !== "delete" && !file.sha256) {
      throw new Error("non-delete github changes require sha256");
    }
    if (file.action !== "delete" && file.sizeBytes === undefined) {
      throw new Error("non-delete github changes require sizeBytes");
    }
    if (
      file.mode !== undefined &&
      file.mode !== "100644" &&
      file.mode !== "100755" &&
      file.mode !== "120000"
    ) {
      throw new Error("github change mode is invalid");
    }
    if (file.action !== "delete" && file.mode === undefined) {
      throw new Error("non-delete github changes require a valid mode");
    }

    totalFileBytes += file.sizeBytes ?? 0;
    if (totalFileBytes > MAX_PAYLOAD_BYTES) {
      throw new Error("github change manifest exceeds the total file-size limit");
    }
    return {
      path,
      action: file.action,
      ...(file.sha256 ? { sha256: sha(file.sha256, "github change sha256") } : {}),
      ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
      ...(file.mode ? { mode: file.mode } : {}),
      ...(previousPath ? { previousPath } : {}),
    };
  });

  const manifest: GitHubChangeManifest = {
    version: 1,
    files,
    ...(input.title
      ? { title: boundedText(input.title, "github change title", MAX_LABEL_LENGTH) }
      : {}),
    ...(input.summary
      ? { summary: boundedText(input.summary, "github change summary", 2_000) }
      : {}),
  };
  const serialized = stableJson(manifest);
  const sizeBytes = Buffer.byteLength(serialized);
  if (sizeBytes > MAX_MANIFEST_BYTES) throw new Error("github change manifest is too large");
  return { manifest, serialized, sizeBytes };
}

export function publicationRequestFingerprint(input: {
  readonly changeSetFingerprint: string;
  readonly targetBranch: string;
  readonly headBranch: string;
  readonly draft: boolean;
  readonly commitMessage: string;
  readonly pullRequestTitle: string;
  readonly pullRequestBody: string;
}): string {
  return sha256(stableJson(input));
}

export function assertRunRepositoryBinding(
  run: RunRepositoryBinding,
  repoFullName: string,
): void {
  const bound = new Set<string>();
  for (const resource of run.resolvedResources) {
    if (
      resource.locator.type === "github.repository" ||
      resource.locator.type === "github.pull_request"
    ) {
      bound.add(resource.locator.repository.toLowerCase());
    }
  }
  if (!bound.has(repoFullName.toLowerCase())) {
    throw new Error("repoFullName is not bound to this run");
  }
}

export function assertChangeSetExpiry(expiresAt: Date, now = Date.now()): void {
  const expiry = expiresAt instanceof Date ? expiresAt.getTime() : Number.NaN;
  if (
    !Number.isFinite(expiry) ||
    expiry <= now ||
    expiry > now + GITHUB_CHANGE_SET_MAX_TTL_MS
  ) {
    throw new Error("expiresAt must be within the server change-set TTL");
  }
}

export function assertPublicationRequestMatches(
  existing: Pick<GitHubPublicationReceiptRecord, "requestFingerprint">,
  requestFingerprint: string,
): void {
  if (existing.requestFingerprint !== requestFingerprint) {
    throw new GitHubPublicationIdempotencyConflictError();
  }
}
