import { createHash } from "node:crypto";
import {
  extractDocxText,
  extractPptxDeck,
  extractPptxSlides,
  extractXlsxWorkbook,
  renderArtifactExport,
  type ArtifactExportFormat,
} from "@useagent/artifact-formats";
import {
  artifactAuthoringProfile,
  artifactWorkpieceExports,
  artifactFileExtension,
  contentTypeForName,
  defaultArtifactWorkpieceState,
  DOCX_CONTENT_TYPE,
  inferWorkpieceKind,
  isArtifactWorkpieceState,
  normalizeArtifactContentType,
  PDF_CONTENT_TYPE,
  PPTX_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  type ArtifactWorkpieceKind,
  type ArtifactWorkpieceState,
} from "@useagent/artifact-workspace";
import { db } from "../db/client";
import { getRunForOrg } from "../runs/repo";
import { recordProviderEvent } from "../runs/provider-events";
import { claimUploadForRun } from "../uploads/repo";
import { artifactStorage } from "./storage";
import { buildInitialWorkpieceState, parseWorkpieceState } from "./workpiece";
import {
  createArtifactRecord,
  getArtifactForRunSourcePath,
  toArtifactDescriptor,
  type ArtifactDescriptor,
} from "./repo";
import { publishOrgChange } from "../runs/org-signals";

export const ARTIFACT_AUTHORING_SOURCE_PATH = "/.skynet/artifact-workspace";

export interface ArtifactExportBytes {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
}

export class ArtifactAuthoringError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactAuthoringError";
  }
}

function safeName(raw: string | undefined, kind: ArtifactWorkpieceKind): string {
  const defaultName = artifactAuthoringProfile(kind).defaultName;
  const name = (raw?.normalize("NFKC").trim() || defaultName)
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .slice(0, 180);
  return name || defaultName;
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "artifact";
}

function normalizedState(
  kind: ArtifactWorkpieceKind,
  value: unknown,
  name: string,
): ArtifactWorkpieceState | null {
  if (value === undefined) return defaultArtifactWorkpieceState(kind, name);
  return parseWorkpieceState(kind, value);
}

function exportName(sourceName: string, extension: string): string {
  const base = stem(sourceName);
  return base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
}

function exportFormatForKind(kind: ArtifactWorkpieceKind, preferred?: string): ArtifactExportFormat {
  const exports = artifactWorkpieceExports(kind);
  const format = preferred === undefined
    ? exports[0]?.format
    : exports.find((item) => item.format === preferred)?.format;
  if (!format) {
    throw new ArtifactAuthoringError(
      400,
      `format must be one of: ${exports.map((item) => item.format).join(", ")}`,
    );
  }
  return format;
}

export async function exportWorkpieceState<Kind extends ArtifactWorkpieceKind>(input: {
  readonly name: string;
  readonly kind: Kind;
  readonly state: ArtifactWorkpieceState<Kind>;
  readonly format?: string;
}): Promise<ArtifactExportBytes> {
  const format = exportFormatForKind(input.kind, input.format);
  if (!isArtifactWorkpieceState(input.kind, input.state)) {
    throw new ArtifactAuthoringError(400, "invalid artifact workpiece state");
  }

  let output: Awaited<ReturnType<typeof renderArtifactExport>>;
  try {
    output = await renderArtifactExport(input.state, format);
  } catch (error) {
    if (error instanceof ArtifactAuthoringError) throw error;
    throw new ArtifactAuthoringError(422, "artifact export could not be rendered");
  }
  return {
    bytes: output.bytes,
    contentType: output.contentType,
    filename: exportName(input.name, output.extension),
  };
}

export async function stateFromNativeArtifact(input: {
  readonly kind: ArtifactWorkpieceKind;
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}): Promise<ArtifactWorkpieceState | null> {
  const suffix = artifactFileExtension(input.name);
  const mime = normalizeArtifactContentType(input.contentType);
  try {
    if (input.kind === "document" && (suffix === "docx" || mime === DOCX_CONTENT_TYPE)) {
      const text = await extractDocxText(input.bytes);
      const state = parseWorkpieceState("document", { text });
      if (!state) throw new Error("invalid extracted document state");
      return state;
    }
    if (input.kind === "spreadsheet" && (suffix === "xlsx" || mime === XLSX_CONTENT_TYPE)) {
      const workbook = await extractXlsxWorkbook(input.bytes);
      const state = parseWorkpieceState("spreadsheet", { workbook });
      if (!state) throw new Error("invalid extracted spreadsheet state");
      return state;
    }
    if (input.kind === "presentation" && (suffix === "pptx" || mime === PPTX_CONTENT_TYPE)) {
      // Prefer the structured native import (positioned blocks + colors +
      // backgrounds); fall back to a text-only import when nothing parses. Image
      // extraction into separate artifacts is the artifact_publish lane's job (it
      // owns the run/storage); an upload keeps images in the original + preview.
      const imported = await extractPptxDeck(input.bytes);
      if (imported) {
        const deckState = parseWorkpieceState("presentation", { deck: imported.deck });
        if (deckState) return deckState;
      }
      const slides = await extractPptxSlides(input.bytes);
      const state = parseWorkpieceState("presentation", { slides });
      if (!state) throw new Error("invalid extracted presentation state");
      return state;
    }
  } catch {
    throw new ArtifactAuthoringError(422, `uploaded ${input.kind} could not be extracted`);
  }
  if (input.kind === "pdf" && (suffix === "pdf" || mime === PDF_CONTENT_TYPE)) {
    return null;
  }
  return null;
}

async function stateFromUploadedSource(input: {
  readonly kind: ArtifactWorkpieceKind;
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly sizeBytes: number;
}): Promise<ArtifactWorkpieceState> {
  const inferred = inferWorkpieceKind(input.name, input.contentType, input.sizeBytes);
  if (!inferred) {
    throw new ArtifactAuthoringError(422, "uploaded file type is not editable in the browser");
  }
  if (inferred !== input.kind) {
    throw new ArtifactAuthoringError(
      422,
      `uploaded file is a ${inferred} workpiece, not ${input.kind}`,
    );
  }

  const native = await stateFromNativeArtifact(input);
  if (native) return native;

  const direct = buildInitialWorkpieceState({
    kind: input.kind,
    sourceName: input.name,
    sourceContentType: input.contentType,
    sourceBytes: input.bytes,
  });
  if (direct) return direct;

  throw new ArtifactAuthoringError(
    422,
    "uploaded file needs a validated import before it can be edited in the browser",
  );
}

function authoredStateIdentity(input: {
  readonly kind: ArtifactWorkpieceKind;
  readonly name: string;
  readonly state: ArtifactWorkpieceState;
}): string {
  return createHash("sha256")
    .update(input.kind)
    .update("\0")
    .update(input.name)
    .update("\0")
    .update(JSON.stringify(input.state))
    .digest("hex");
}

function authoredSourcePath(kind: ArtifactWorkpieceKind, stateId: string, filename: string): string {
  return `${ARTIFACT_AUTHORING_SOURCE_PATH}/${kind}/${stateId}/${filename}`;
}

export async function createAuthoredArtifact(input: {
  readonly orgId: string;
  readonly userId: string | null;
  readonly runId: string;
  readonly threadId?: string;
  readonly kind: ArtifactWorkpieceKind;
  readonly name?: string;
  readonly state?: unknown;
  readonly uploadId?: string;
}): Promise<{ artifact: ArtifactDescriptor; created: boolean }> {
  const run = await getRunForOrg(input.orgId, input.runId);
  if (!run || (input.threadId && run.threadId !== input.threadId)) {
    throw new ArtifactAuthoringError(404, "run not found in this thread");
  }

  const requestedName = safeName(input.name, input.kind);
  const record = await db.transaction(async (tx) => {
    let artifactName = requestedName;
    let artifactContentType = contentTypeForName(requestedName);
    let sourceBytes: Uint8Array;
    let sourcePath: string;
    let state: ArtifactWorkpieceState;

    if (input.uploadId) {
      if (!input.userId) {
        throw new ArtifactAuthoringError(401, "authenticated user required for upload artifacts");
      }
      const upload = await claimUploadForRun({
        id: input.uploadId,
        orgId: input.orgId,
        userId: input.userId,
        runId: run.id,
      }, tx);
      sourceBytes = await artifactStorage().read(upload.storageKey);
      if (sourceBytes.byteLength !== upload.sizeBytes) {
        throw new ArtifactAuthoringError(409, "upload bytes unavailable");
      }
      state = await stateFromUploadedSource({
        kind: input.kind,
        name: upload.name,
        contentType: upload.contentType,
        bytes: sourceBytes,
        sizeBytes: upload.sizeBytes,
      });
      sourcePath = `${ARTIFACT_AUTHORING_SOURCE_PATH}/uploads/${upload.id}/${upload.name}`;
      artifactName = upload.name;
      artifactContentType = upload.contentType;
    } else {
      const authoredState = normalizedState(input.kind, input.state, requestedName);
      if (!authoredState) throw new ArtifactAuthoringError(400, "invalid workpiece state");
      const exported = await exportWorkpieceState({
        name: requestedName,
        kind: input.kind,
        state: authoredState,
      });
      sourceBytes = exported.bytes;
      const stateId = authoredStateIdentity({
        kind: input.kind,
        name: requestedName,
        state: authoredState,
      });
      sourcePath = authoredSourcePath(input.kind, stateId, exported.filename);
      artifactName = exported.filename;
      artifactContentType = exported.contentType;
      state = authoredState;
    }

    const digest = createHash("sha256").update(sourceBytes).digest("hex");
    const existingAuthored = input.uploadId
      ? null
      : await getArtifactForRunSourcePath(run.id, sourcePath, tx);
    if (existingAuthored) {
      if (
        JSON.stringify(existingAuthored.workpieceState) !== JSON.stringify(state) ||
        existingAuthored.workpieceKind !== input.kind
      ) {
        throw new ArtifactAuthoringError(
          409,
          "artifact editable companion conflicts with the existing publication",
        );
      }
      return { row: existingAuthored, created: false };
    }
    const created = await createArtifactRecord({
      orgId: input.orgId,
      userId: input.userId,
      runId: run.id,
      threadId: run.threadId,
      sourcePath,
      name: artifactName,
      contentType: artifactContentType,
      sizeBytes: sourceBytes.byteLength,
      sha256: digest,
      storageKey: digest,
      workpieceKind: input.kind,
      workpieceState: state,
    }, tx);
    await artifactStorage().put(digest, sourceBytes);
    return created;
  });

  if (record.created) {
    const descriptor = toArtifactDescriptor(record.row);
    await recordProviderEvent(
      {
        id: `artifact.created:${record.row.id}`,
        runId: run.id,
        threadId: run.threadId,
        provider: "skynet",
        eventType: "artifact.created",
        payload: descriptor,
      },
      { critical: true },
    );
    publishOrgChange(input.orgId, {
      type: "artifact",
      action: "created",
      artifactId: record.row.id,
      runId: run.id,
      threadId: run.threadId,
    });
  }
  return { artifact: toArtifactDescriptor(record.row), created: record.created };
}
