import { Hono, type Context } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { canPreviewInline } from "./mime";
import {
  getArtifactForOrg,
  listArtifactsForOrg,
  toArtifactDescriptor,
  updateArtifactWorkpiece,
  type ArtifactRecord,
} from "./repo";
import { artifactStorage, type ArtifactByteRange } from "./storage";
import { parseWorkpieceState } from "./workpiece";
import { publishOrgChange } from "../runs/org-signals";

function disposition(name: string, inline: boolean): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function parseRange(value: string | undefined, size: number): ArtifactByteRange | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) throw new Error("invalid_range");
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) throw new Error("invalid_range");
  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error("invalid_range");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    throw new Error("invalid_range");
  }
  return { start, end: Math.min(end, size - 1) };
}

function contentHeaders(
  artifact: ArtifactRecord,
  inline: boolean,
  range: ArtifactByteRange | null,
): Headers {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=300",
    "content-disposition": disposition(artifact.name, inline),
    "content-type": artifact.contentType,
    "cross-origin-resource-policy": "same-origin",
    etag: `"sha256-${artifact.sha256}"`,
    "x-content-type-options": "nosniff",
  });
  const length = range ? range.end - range.start + 1 : artifact.sizeBytes;
  headers.set("content-length", String(length));
  if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${artifact.sizeBytes}`);
  return headers;
}

export const artifactRoutes = new Hono<AppEnv>();
artifactRoutes.use("*", orgScope);

artifactRoutes.get("/", async (c) => {
  const rows = await listArtifactsForOrg({
    orgId: c.get("orgId"),
    runId: c.req.query("run_id") || undefined,
    threadId: c.req.query("thread_id") || undefined,
  });
  return c.json({ artifacts: rows.map(toArtifactDescriptor) });
});

artifactRoutes.get("/:id", async (c) => {
  const row = await getArtifactForOrg(c.get("orgId"), c.req.param("id"));
  return row ? c.json({ artifact: toArtifactDescriptor(row) }) : c.json({ error: "not found" }, 404);
});

function workpieceResponse(artifact: ArtifactRecord) {
  return {
    workpiece: toArtifactDescriptor(artifact).workpiece,
    state: artifact.workpieceState ?? null,
  };
}

artifactRoutes.get("/:id/workpiece", async (c) => {
  const artifact = await getArtifactForOrg(c.get("orgId"), c.req.param("id"));
  if (!artifact?.workpieceKind) return c.json({ error: "not found" }, 404);
  return c.json(workpieceResponse(artifact));
});

artifactRoutes.patch("/:id/workpiece", async (c) => {
  const artifact = await getArtifactForOrg(c.get("orgId"), c.req.param("id"));
  if (!artifact?.workpieceKind) return c.json({ error: "not found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "invalid workpiece update" }, 400);
  }
  const input = body as Record<string, unknown>;
  const expectedRevision = input.expected_revision;
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
    return c.json({ error: "expected_revision must be a non-negative integer" }, 400);
  }
  const state = parseWorkpieceState(artifact.workpieceKind, input.state);
  if (!state) return c.json({ error: "invalid workpiece state" }, 400);

  const updated = await updateArtifactWorkpiece({
    orgId: c.get("orgId"),
    id: artifact.id,
    expectedRevision: Number(expectedRevision),
    state,
  });
  if (updated) {
    publishOrgChange(c.get("orgId"), {
      type: "artifact",
      action: "updated",
      artifactId: updated.id,
      runId: updated.runId,
      threadId: updated.threadId,
    });
    return c.json(workpieceResponse(updated));
  }

  const current = await getArtifactForOrg(c.get("orgId"), artifact.id);
  return current?.workpieceKind
    ? c.json({ error: "revision conflict", ...workpieceResponse(current) }, 409)
    : c.json({ error: "not found" }, 404);
});

async function serveContent(c: Context<AppEnv>) {
  const artifact = await getArtifactForOrg(c.get("orgId"), c.req.param("id") ?? "");
  if (!artifact) return c.json({ error: "not found" }, 404);
  let range: ArtifactByteRange | null;
  try {
    range = parseRange(c.req.header("range"), artifact.sizeBytes);
  } catch {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${artifact.sizeBytes}` },
    });
  }
  const inline = c.req.query("download") !== "1" && canPreviewInline(artifact.contentType);
  try {
    if ((await artifactStorage().size(artifact.storageKey)) !== artifact.sizeBytes) {
      throw new Error("artifact size mismatch");
    }
    const headers = contentHeaders(artifact, inline, range);
    if (c.req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
    const bytes = await artifactStorage().read(artifact.storageKey, range ?? undefined);
    return new Response(bytes, { status: range ? 206 : 200, headers });
  } catch {
    return c.json({ error: "artifact bytes unavailable" }, 410);
  }
}

artifactRoutes.get("/:id/content", serveContent);
artifactRoutes.on("HEAD", "/:id/content", serveContent);
