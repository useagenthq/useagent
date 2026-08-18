import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  ARTIFACT_PROPOSAL_STATUSES,
  isArtifactWorkpieceState,
  type ArtifactWorkpieceKind,
} from "@skynet/artifact-workspace";
import {
  applyPdfPageOperation,
  buildArtifactBundle,
  PdfPageOperationError,
  type ArtifactBundleEntry,
  type PdfPageOperation,
} from "@skynet/artifact-formats";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { ArtifactAuthoringError, createAuthoredArtifact, exportWorkpieceState } from "./authoring";
import { canPreviewInline } from "./mime";
import {
  applyArtifactPdfPageRevision,
  getArtifactForOrg,
  listArtifactsForOrg,
  toArtifactDescriptor,
  updateArtifactWorkpiece,
  type ArtifactRecord,
} from "./repo";
import { artifactStorage, type ArtifactByteRange } from "./storage";
import { parseWorkpieceState } from "./workpiece";
import {
  acceptWorkpieceProposal,
  dismissWorkpieceProposal,
  getWorkpieceProposalForOrg,
  listWorkpieceProposals,
  toProposalDescriptor,
} from "./proposals";
import { publishOrgChange } from "../runs/org-signals";
import { UploadClaimError } from "../uploads/repo";

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

// A run's artifacts are packaged in-memory before streaming, so both the count
// and the summed byte size are bounded. The count cap matches the artifact list
// page size; a run with more artifacts archives its most recent ones.
const ARCHIVE_MAX_ARTIFACTS = 100;
const ARCHIVE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

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

// Download every published artifact of a run as one ZIP. Org-scoped like every
// other read; bounded in count and total size so the bundle is built safely in
// memory before streaming.
artifactRoutes.get("/runs/:runId/archive", async (c) => {
  const orgId = c.get("orgId");
  const runId = c.req.param("runId");
  const rows = await listArtifactsForOrg({ orgId, runId, limit: ARCHIVE_MAX_ARTIFACTS });
  if (rows.length === 0) return c.json({ error: "no artifacts to archive" }, 404);

  const totalBytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
  if (totalBytes > ARCHIVE_MAX_TOTAL_BYTES) {
    return c.json({ error: "run artifacts exceed the archive size limit" }, 413);
  }

  const entries: ArtifactBundleEntry[] = [];
  try {
    for (const row of rows) {
      entries.push({ name: row.name, bytes: await artifactStorage().read(row.storageKey) });
    }
  } catch {
    return c.json({ error: "artifact bytes unavailable" }, 410);
  }

  const bundle = await buildArtifactBundle(entries);
  return new Response(bundle.bytes, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": disposition(`run-${runId}-artifacts.zip`, false),
      "content-length": String(bundle.bytes.byteLength),
      "content-type": bundle.contentType,
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    },
  });
});

function parseWorkpieceKind(value: unknown): ArtifactWorkpieceKind | null {
  return value === "document" ||
      value === "spreadsheet" ||
      value === "presentation" ||
      value === "pdf"
    ? value
    : null;
}

artifactRoutes.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "invalid artifact create request" }, 400);
  }
  const input = body as Record<string, unknown>;
  const runId = typeof input.run_id === "string" ? input.run_id.trim() : "";
  const threadId = typeof input.thread_id === "string" ? input.thread_id.trim() : undefined;
  const kind = parseWorkpieceKind(input.kind);
  const name = typeof input.name === "string" ? input.name : undefined;
  const uploadId = typeof input.upload_id === "string" ? input.upload_id.trim() : undefined;
  if (!runId) return c.json({ error: "run_id is required" }, 400);
  if (!kind) return c.json({ error: "kind must be document, spreadsheet, presentation, or pdf" }, 400);
  try {
    const created = await createAuthoredArtifact({
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      runId,
      threadId,
      kind,
      name,
      state: input.state,
      uploadId,
    });
    return c.json({ artifact: created.artifact, created: created.created }, created.created ? 201 : 200);
  } catch (error) {
    if (error instanceof ArtifactAuthoringError) {
      return c.json({ error: error.message }, error.status);
    }
    if (error instanceof UploadClaimError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
    throw error;
  }
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

artifactRoutes.get("/:id/workpiece/export", async (c) => {
  const artifact = await getArtifactForOrg(c.get("orgId"), c.req.param("id"));
  if (!artifact?.workpieceKind || !artifact.workpieceState) {
    return c.json({ error: "not found" }, 404);
  }
  if (!isArtifactWorkpieceState(artifact.workpieceKind, artifact.workpieceState)) {
    return c.json({ error: "invalid stored workpiece state" }, 409);
  }
  let exported;
  try {
    exported = await exportWorkpieceState({
      name: artifact.name,
      kind: artifact.workpieceKind,
      state: artifact.workpieceState,
      format: c.req.query("format"),
    });
  } catch (error) {
    if (error instanceof ArtifactAuthoringError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }
  return new Response(exported.bytes, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": disposition(exported.filename, false),
      "content-length": String(exported.bytes.byteLength),
      "content-type": exported.contentType,
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    },
  });
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

// Agent-proposed workpiece revisions. Agents write here (via the gateway tool),
// not to mainline; the human reviews and accepts/dismisses through these routes.
// The rendered view keeps showing mainline until an accept lands.
artifactRoutes.get("/:id/proposals", async (c) => {
  const artifact = await getArtifactForOrg(c.get("orgId"), c.req.param("id"));
  if (!artifact?.workpieceKind) return c.json({ error: "not found" }, 404);
  const proposals = await listWorkpieceProposals({
    orgId: c.get("orgId"),
    artifactId: artifact.id,
    statuses: c.req.query("status") === "all" ? ARTIFACT_PROPOSAL_STATUSES : ["pending"],
  });
  return c.json({ proposals: proposals.map(toProposalDescriptor) });
});

// Fold a pending proposal into mainline as a new revision, preserving provenance.
artifactRoutes.post("/:id/proposals/:proposalId/accept", async (c) => {
  const orgId = c.get("orgId");
  const artifact = await getArtifactForOrg(orgId, c.req.param("id"));
  if (!artifact?.workpieceKind) return c.json({ error: "not found" }, 404);

  const result = await acceptWorkpieceProposal({
    orgId,
    artifactId: artifact.id,
    proposalId: c.req.param("proposalId"),
    resolvedBy: c.get("userId") || null,
  });

  if (result.outcome === "not_found") return c.json({ error: "not found" }, 404);
  if (result.outcome === "already_resolved") {
    return c.json(
      { error: "proposal already resolved", proposal: toProposalDescriptor(result.proposal) },
      409,
    );
  }
  if (result.outcome === "revision_conflict") {
    const current = await getArtifactForOrg(orgId, artifact.id);
    return current?.workpieceKind
      ? c.json({ error: "revision conflict", ...workpieceResponse(current) }, 409)
      : c.json({ error: "not found" }, 404);
  }
  publishOrgChange(orgId, {
    type: "artifact",
    action: "updated",
    artifactId: result.artifact.id,
    runId: result.artifact.runId,
    threadId: result.artifact.threadId,
  });
  return c.json({
    ...workpieceResponse(result.artifact),
    proposal: toProposalDescriptor(result.proposal),
  });
});

// Drop a pending proposal, recording the dismissal in history; mainline untouched.
artifactRoutes.post("/:id/proposals/:proposalId/dismiss", async (c) => {
  const orgId = c.get("orgId");
  const artifact = await getArtifactForOrg(orgId, c.req.param("id"));
  if (!artifact?.workpieceKind) return c.json({ error: "not found" }, 404);

  const dismissed = await dismissWorkpieceProposal({
    orgId,
    artifactId: artifact.id,
    proposalId: c.req.param("proposalId"),
    resolvedBy: c.get("userId") || null,
  });
  if (!dismissed) {
    const existing = await getWorkpieceProposalForOrg({
      orgId,
      artifactId: artifact.id,
      proposalId: c.req.param("proposalId"),
    });
    return existing
      ? c.json(
          { error: "proposal already resolved", proposal: toProposalDescriptor(existing) },
          409,
        )
      : c.json({ error: "not found" }, 404);
  }
  publishOrgChange(orgId, {
    type: "artifact",
    action: "proposed",
    artifactId: artifact.id,
    runId: artifact.runId,
    threadId: artifact.threadId,
  });
  return c.json({ proposal: toProposalDescriptor(dismissed) });
});

function parsePdfPageOperation(value: unknown): PdfPageOperation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const indices = (raw: unknown): number[] | null =>
    Array.isArray(raw) && raw.every((entry) => Number.isSafeInteger(entry))
      ? (raw as number[])
      : null;
  if (input.type === "reorder") {
    const order = indices(input.order);
    return order ? { type: "reorder", order } : null;
  }
  if (input.type === "delete") {
    const pages = indices(input.pages);
    return pages ? { type: "delete", pages } : null;
  }
  return null;
}

// Structural page reorder/delete for a PDF workpiece, persisted as a new
// revision of the same artifact. Only byte-authoritative PDFs (published or
// generated, no text state) are eligible; a text-authored PDF is edited through
// its pdfText workpiece so its bytes are never the source of truth.
artifactRoutes.post("/:id/workpiece/pdf-pages", async (c) => {
  const artifact = await getArtifactForOrg(c.get("orgId"), c.req.param("id"));
  if (!artifact?.workpieceKind) return c.json({ error: "not found" }, 404);
  if (artifact.workpieceKind !== "pdf") {
    return c.json({ error: "page operations are only available on PDF workpieces" }, 409);
  }
  if (artifact.workpieceState) {
    return c.json({ error: "page operations apply to published PDFs, not text-authored PDFs" }, 409);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "invalid page operation request" }, 400);
  }
  const input = body as Record<string, unknown>;
  const expectedRevision = input.expected_revision;
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
    return c.json({ error: "expected_revision must be a non-negative integer" }, 400);
  }
  const operation = parsePdfPageOperation(input.operation);
  if (!operation) {
    return c.json({ error: "operation must be a reorder or delete with integer page indices" }, 400);
  }

  let sourceBytes: Uint8Array;
  try {
    sourceBytes = await artifactStorage().read(artifact.storageKey);
  } catch {
    return c.json({ error: "artifact bytes unavailable" }, 410);
  }

  let outputBytes: Uint8Array;
  try {
    outputBytes = await applyPdfPageOperation(sourceBytes, operation);
  } catch (error) {
    if (error instanceof PdfPageOperationError) return c.json({ error: error.message }, 422);
    throw error;
  }

  const digest = createHash("sha256").update(outputBytes).digest("hex");
  await artifactStorage().put(digest, outputBytes);
  const updated = await applyArtifactPdfPageRevision({
    orgId: c.get("orgId"),
    id: artifact.id,
    expectedRevision: Number(expectedRevision),
    sha256: digest,
    storageKey: digest,
    sizeBytes: outputBytes.byteLength,
  });
  if (!updated) {
    const current = await getArtifactForOrg(c.get("orgId"), artifact.id);
    return current
      ? c.json({ error: "revision conflict", artifact: toArtifactDescriptor(current) }, 409)
      : c.json({ error: "not found" }, 404);
  }
  publishOrgChange(c.get("orgId"), {
    type: "artifact",
    action: "updated",
    artifactId: updated.id,
    runId: updated.runId,
    threadId: updated.threadId,
  });
  return c.json({ artifact: toArtifactDescriptor(updated) });
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
