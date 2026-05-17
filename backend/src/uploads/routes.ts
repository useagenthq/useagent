import { Hono } from "hono";
import type { AppEnv } from "../http";
import { contentTypeForName } from "../artifacts/mime";
import { artifactStorage } from "../artifacts/storage";
import { orgScope } from "../middleware/org";
import {
  createUserUpload,
  deleteReadyUpload,
  getOwnedUpload,
  toUserUploadDescriptor,
} from "./repo";
import { scanUploadBytes, UploadScanError } from "./scan";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOADS_OVERHEAD = 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const SAFE_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*charset=[a-z0-9._-]+)?$/i;

export function validateUploadName(raw: string): string | null {
  const name = raw.normalize("NFKC").trim();
  if (!name || name.length > 180 || /[\\/\0\r\n]/.test(name)) return null;
  return name;
}

function trustedContentType(name: string, supplied: string): string {
  const inferred = contentTypeForName(name);
  if (inferred !== "application/octet-stream") return inferred;
  return SAFE_MIME.test(supplied) ? supplied.toLowerCase() : inferred;
}

function disposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export const uploadRoutes = new Hono<AppEnv>();
uploadRoutes.use("*", orgScope);

uploadRoutes.post("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "authenticated user required" }, 401);
  const declaredLength = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES + MAX_UPLOADS_OVERHEAD) {
    return c.json({ error: "file exceeds 25 MB limit" }, 413);
  }

  let value: unknown;
  try {
    value = (await c.req.formData()).get("file");
  } catch {
    return c.json({ error: "invalid multipart form" }, 400);
  }
  if (!(value instanceof File)) return c.json({ error: "file is required" }, 400);
  const name = validateUploadName(value.name);
  if (!name) return c.json({ error: "invalid file name" }, 400);
  if (value.size <= 0) return c.json({ error: "file is empty" }, 400);
  if (value.size > MAX_UPLOAD_BYTES) return c.json({ error: "file exceeds 25 MB limit" }, 413);

  const bytes = new Uint8Array(await value.arrayBuffer());
  const contentType = trustedContentType(name, value.type);
  try {
    await scanUploadBytes({ name, contentType, bytes });
  } catch (error) {
    if (error instanceof UploadScanError) {
      return c.json({ error: error.code }, 422);
    }
    throw error;
  }
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const row = await createUserUpload({
    orgId: c.get("orgId"),
    userId,
    name,
    contentType,
    sizeBytes: bytes.byteLength,
    sha256,
    storageKey: sha256,
    expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
  });
  try {
    // The metadata reference must exist before byte publication so concurrent
    // orphan reclamation retains this digest. Roll it back if storage fails.
    await artifactStorage().put(sha256, bytes);
  } catch (error) {
    await deleteReadyUpload(c.get("orgId"), userId, row.id);
    throw error;
  }
  return c.json({ upload: toUserUploadDescriptor(row) }, 201);
});

uploadRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "authenticated user required" }, 401);
  const removed = await deleteReadyUpload(c.get("orgId"), userId, c.req.param("id"));
  return removed ? new Response(null, { status: 204 }) : c.json({ error: "not found" }, 404);
});

uploadRoutes.get("/:id/content", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "authenticated user required" }, 401);
  const row = await getOwnedUpload(c.get("orgId"), userId, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  if (!row.runId && row.expiresAt.getTime() <= Date.now()) {
    return c.json({ error: "not found" }, 404);
  }
  try {
    const bytes = await artifactStorage().read(row.storageKey);
    if (bytes.byteLength !== row.sizeBytes) throw new Error("upload size mismatch");
    return new Response(bytes, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": disposition(row.name),
        "content-length": String(row.sizeBytes),
        "content-type": row.contentType,
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return c.json({ error: "upload bytes unavailable" }, 410);
  }
});
