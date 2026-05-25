import { contentTypeForName } from "../artifacts/mime";
import { artifactStorage } from "../artifacts/storage";
import { createUserUpload, deleteReadyUpload, type UserUploadRecord } from "./repo";
import { scanUploadBytes } from "./scan";

// ---------------------------------------------------------------------------
// Upload ingestion — the ONE scan + persist lane every inbound byte source goes
// through (the browser upload route, Slack inbound attachments). Extracted from
// the POST /api/uploads handler so a second ingress cannot fork the pattern.
// ---------------------------------------------------------------------------

export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const SAFE_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*charset=[a-z0-9._-]+)?$/i;

/** Infer the content type from the (validated) name; fall back to the supplied
 *  type only when it looks like a plain, well-formed MIME string. */
export function trustedContentType(name: string, supplied: string): string {
  const inferred = contentTypeForName(name);
  if (inferred !== "application/octet-stream") return inferred;
  return SAFE_MIME.test(supplied) ? supplied.toLowerCase() : inferred;
}

/**
 * Scan and persist one user-provided file into the uploads lane: content scan
 * (throws UploadScanError on rejection), content-addressed byte storage, and a
 * ready `user_uploads` row the durable command lane can claim for a run. The
 * metadata row is created BEFORE byte publication so concurrent orphan
 * reclamation retains the digest; a storage failure rolls the row back.
 */
export async function ingestUserUpload(input: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly suppliedContentType: string;
  readonly bytes: Uint8Array;
}): Promise<UserUploadRecord> {
  const contentType = trustedContentType(input.name, input.suppliedContentType);
  await scanUploadBytes({ name: input.name, contentType, bytes: input.bytes });
  const sha256 = new Bun.CryptoHasher("sha256").update(input.bytes).digest("hex");
  const row = await createUserUpload({
    orgId: input.orgId,
    userId: input.userId,
    name: input.name,
    contentType,
    sizeBytes: input.bytes.byteLength,
    sha256,
    storageKey: sha256,
    expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
  });
  try {
    // The metadata reference must exist before byte publication so concurrent
    // orphan reclamation retains this digest. Roll it back if storage fails.
    await artifactStorage().put(sha256, input.bytes);
  } catch (error) {
    await deleteReadyUpload(input.orgId, input.userId, row.id);
    throw error;
  }
  return row;
}
