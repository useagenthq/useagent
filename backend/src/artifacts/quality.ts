import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { artifactQualityReceipts, artifacts } from "../db/schema";
import { stableJson } from "../github/publication-repo-input";
import type { ArtifactRecord } from "./repo";

const SHA256 = /^[0-9a-f]{64}$/u;
const PROFILE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const EXPORT_FORMAT = /^[a-z0-9][a-z0-9._+-]{0,63}$/u;
const INSPECTOR_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;

export type ArtifactQualityReceipt = typeof artifactQualityReceipts.$inferSelect;

export class ArtifactQualityStaleSubjectError extends Error {
  constructor() {
    super("artifact quality inspection subject is stale");
    this.name = "ArtifactQualityStaleSubjectError";
  }
}

export class ArtifactQualityIdempotencyConflictError extends Error {
  constructor() {
    super("artifact quality idempotency key was reused for a different request");
    this.name = "ArtifactQualityIdempotencyConflictError";
  }
}

export class ArtifactQualitySubjectConflictError extends Error {
  constructor() {
    super("artifact quality subject and profile already have a different receipt");
    this.name = "ArtifactQualitySubjectConflictError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function checked(value: string, name: string, pattern: RegExp): string {
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

export function artifactSubjectDigest(
  artifact: Pick<ArtifactRecord, "sha256" | "workpieceKind" | "workpieceState">,
): string {
  if (artifact.workpieceKind && artifact.workpieceState) {
    return digest(stableJson({ kind: artifact.workpieceKind, state: artifact.workpieceState }));
  }
  return artifact.sha256;
}

export interface RecordArtifactQualityInput {
  readonly orgId: string;
  readonly artifactId: string;
  readonly threadId: string;
  readonly artifactRevision: number;
  readonly subjectDigest: string;
  readonly qualityProfile: string;
  readonly exportFormat: string;
  readonly exportDigest: string;
  readonly visualDigest: string;
  readonly inspectorVersion: string;
  readonly idempotencyKey: string;
}

export async function recordArtifactQuality(
  input: RecordArtifactQualityInput,
): Promise<{ row: ArtifactQualityReceipt; created: boolean }> {
  const orgId = input.orgId.trim();
  const artifactId = input.artifactId.trim();
  const threadId = input.threadId.trim();
  if (!orgId || !artifactId || !threadId) throw new Error("artifact quality scope is invalid");
  if (!Number.isSafeInteger(input.artifactRevision) || input.artifactRevision < 0) {
    throw new Error("artifactRevision is invalid");
  }
  const subjectDigest = checked(input.subjectDigest, "subjectDigest", SHA256);
  const qualityProfile = checked(input.qualityProfile, "qualityProfile", PROFILE);
  const exportFormat = checked(input.exportFormat, "exportFormat", EXPORT_FORMAT);
  const exportDigest = checked(input.exportDigest, "exportDigest", SHA256);
  const visualDigest = checked(input.visualDigest, "visualDigest", SHA256);
  const inspectorVersion = checked(input.inspectorVersion, "inspectorVersion", INSPECTOR_VERSION);
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error("idempotencyKey is invalid");
  }
  const idempotencyKeyHash = digest(idempotencyKey);
  const request = {
    orgId,
    artifactId,
    threadId,
    artifactRevision: input.artifactRevision,
    subjectDigest,
    qualityProfile,
    exportFormat,
    exportDigest,
    visualDigest,
    inspectorVersion,
  };
  const requestFingerprint = digest(stableJson(request));

  return db.transaction(async (tx) => {
    const [artifact] = await tx
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.orgId, orgId), eq(artifacts.id, artifactId)))
      .limit(1)
      .for("update");
    if (!artifact) throw new ArtifactQualityStaleSubjectError();

    // A completed request remains replayable even if the artifact later
    // advances. Only a new key is eligible to certify the current subject.
    const [byKey] = await tx
      .select()
      .from(artifactQualityReceipts)
      .where(
        and(
          eq(artifactQualityReceipts.orgId, orgId),
          eq(artifactQualityReceipts.idempotencyKeyHash, idempotencyKeyHash),
        ),
      )
      .limit(1);
    if (byKey) {
      if (byKey.requestFingerprint !== requestFingerprint) {
        throw new ArtifactQualityIdempotencyConflictError();
      }
      return { row: byKey, created: false };
    }
    if (
      artifact.threadId !== threadId ||
      artifact.workpieceRevision !== input.artifactRevision ||
      artifactSubjectDigest(artifact) !== subjectDigest
    ) {
      throw new ArtifactQualityStaleSubjectError();
    }

    const [inserted] = await tx
      .insert(artifactQualityReceipts)
      .values({ ...request, idempotencyKeyHash, requestFingerprint })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { row: inserted, created: true };

    const [racedByKey] = await tx
      .select()
      .from(artifactQualityReceipts)
      .where(
        and(
          eq(artifactQualityReceipts.orgId, orgId),
          eq(artifactQualityReceipts.idempotencyKeyHash, idempotencyKeyHash),
        ),
      )
      .limit(1);
    if (racedByKey) {
      if (racedByKey.requestFingerprint !== requestFingerprint) {
        throw new ArtifactQualityIdempotencyConflictError();
      }
      return { row: racedByKey, created: false };
    }

    const [bySubject] = await tx
      .select()
      .from(artifactQualityReceipts)
      .where(
        and(
          eq(artifactQualityReceipts.orgId, orgId),
          eq(artifactQualityReceipts.artifactId, artifactId),
          eq(artifactQualityReceipts.threadId, threadId),
          eq(artifactQualityReceipts.artifactRevision, input.artifactRevision),
          eq(artifactQualityReceipts.subjectDigest, subjectDigest),
          eq(artifactQualityReceipts.qualityProfile, qualityProfile),
        ),
      )
      .limit(1);
    if (bySubject?.requestFingerprint === requestFingerprint) {
      return { row: bySubject, created: false };
    }
    throw new ArtifactQualitySubjectConflictError();
  });
}

export type ArtifactQualityStatus =
  | { readonly status: "not_found" }
  | {
      readonly status: "unverified";
      readonly artifactRevision: number;
      readonly subjectDigest: string;
    }
  | ({ readonly status: "verified" } & ArtifactQualityReceipt);

export async function getArtifactQualityForOrg(
  orgId: string,
  artifactId: string,
): Promise<ArtifactQualityStatus> {
  return db.transaction(async (tx) => {
    const [artifact] = await tx
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.orgId, orgId), eq(artifacts.id, artifactId)))
      .limit(1)
      .for("share");
    if (!artifact) return { status: "not_found" };
    const subjectDigest = artifactSubjectDigest(artifact);
    const [receipt] = await tx
      .select()
      .from(artifactQualityReceipts)
      .where(
        and(
          eq(artifactQualityReceipts.orgId, artifact.orgId),
          eq(artifactQualityReceipts.artifactId, artifact.id),
          eq(artifactQualityReceipts.threadId, artifact.threadId),
          eq(artifactQualityReceipts.artifactRevision, artifact.workpieceRevision),
          eq(artifactQualityReceipts.subjectDigest, subjectDigest),
        ),
      )
      .orderBy(desc(artifactQualityReceipts.createdAt), desc(artifactQualityReceipts.id))
      .limit(1);
    return receipt
      ? { status: "verified", ...receipt }
      : { status: "unverified", artifactRevision: artifact.workpieceRevision, subjectDigest };
  });
}
