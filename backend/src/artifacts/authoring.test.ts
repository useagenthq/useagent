import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as artifactFormats from "@useagent/artifact-formats";
import {
  ARTIFACT_LEGACY_WORKPIECE_ACTIONS,
  artifactWorkpieceExports,
} from "@useagent/artifact-workspace";
import { db } from "../db/client";
import { artifacts, providerEvents, runs, userUploads } from "../db/schema";
import { createRun } from "../runs/repo";
import { createUserUpload } from "../uploads/repo";
import {
  ArtifactAuthoringError,
  createAuthoredArtifact,
  exportWorkpieceState,
} from "./authoring";
import { setArtifactStorageForTest } from "./storage";
import { InMemoryArtifactStorage } from "../../test/in-memory-artifact-storage";
import { createArtifactRecord } from "./repo";
import "../../test/helpers";

const ORG = "org-skynet-dev";
const USER = "artifact-author@example.com";

const storage = new InMemoryArtifactStorage();
const runIds = new Set<string>();
const uploadIds = new Set<string>();

async function sandboxRun(): Promise<string> {
  const id = crypto.randomUUID();
  runIds.add(id);
  await createRun({
    id,
    prompt: "author artifact",
    model: "test",
    engine: "mock",
    orgId: ORG,
    userId: USER,
    parentRunId: null,
    threadId: id,
    repos: [],
    memoryScope: "org",
  });
  return id;
}

async function upload(input: {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}) {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  await storage.put(sha256, input.bytes);
  const row = await createUserUpload({
    orgId: ORG,
    userId: USER,
    name: input.name,
    contentType: input.contentType,
    sizeBytes: input.bytes.byteLength,
    sha256,
    storageKey: sha256,
    expiresAt: new Date(Date.now() + 60_000),
  });
  uploadIds.add(row.id);
  return row;
}

async function createdArtifactEvents(runId: string) {
  return db
    .select()
    .from(providerEvents)
    .where(and(eq(providerEvents.runId, runId), eq(providerEvents.eventType, "artifact.created")));
}

beforeEach(() => {
  storage.values.clear();
  setArtifactStorageForTest(storage);
});

afterEach(async () => {
  for (const runId of runIds) {
    await db.delete(providerEvents).where(eq(providerEvents.runId, runId));
    await db.delete(artifacts).where(eq(artifacts.runId, runId));
  }
  for (const uploadId of uploadIds) {
    await db.delete(userUploads).where(eq(userUploads.id, uploadId));
  }
  for (const runId of runIds) await db.delete(runs).where(eq(runs.id, runId));
  runIds.clear();
  uploadIds.clear();
  setArtifactStorageForTest(null);
});

describe("browser-authored artifacts", () => {
  test("rejects unsupported export formats with a bounded authoring error", async () => {
    await expect(exportWorkpieceState({
      name: "brief.docx",
      kind: "document",
      state: { text: "Ready" },
      format: "zip",
    })).rejects.toMatchObject({
      name: "ArtifactAuthoringError",
      status: 400,
      message: "format must be one of: docx, html, text",
    } satisfies Partial<ArtifactAuthoringError>);
  });

  test("bounds native render failures without exposing library errors", async () => {
    const render = spyOn(artifactFormats, "renderArtifactExport")
      .mockRejectedValue(new Error("sensitive renderer internals"));
    try {
      await expect(exportWorkpieceState({
        name: "brief.pdf",
        kind: "pdf",
        state: { pdfText: "Ready" },
      })).rejects.toMatchObject({
        name: "ArtifactAuthoringError",
        status: 422,
        message: "artifact export could not be rendered",
      } satisfies Partial<ArtifactAuthoringError>);
    } finally {
      render.mockRestore();
    }
  });

  test("reports malformed native uploads as extraction failures and rolls claim back", async () => {
    const runId = await sandboxRun();
    const input = await upload({
      name: "broken.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: Buffer.from("not a docx container"),
    });

    await expect(createAuthoredArtifact({
      orgId: ORG,
      userId: USER,
      runId,
      kind: "document",
      uploadId: input.id,
    })).rejects.toMatchObject({
      name: "ArtifactAuthoringError",
      status: 422,
      message: "uploaded document could not be extracted",
    } satisfies Partial<ArtifactAuthoringError>);

    const [remaining] = await db.select().from(userUploads).where(eq(userUploads.id, input.id));
    expect(remaining?.runId).toBeNull();
    const rows = await db.select().from(artifacts).where(eq(artifacts.runId, runId));
    expect(rows).toHaveLength(0);
  });

  test("rejects native uploads when no real import can be produced and rolls claim back", async () => {
    const runId = await sandboxRun();
    const input = await upload({
      name: "report.pdf",
      contentType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7\nnot imported"),
    });

    await expect(createAuthoredArtifact({
      orgId: ORG,
      userId: USER,
      runId,
      kind: "pdf",
      uploadId: input.id,
    })).rejects.toMatchObject({
      name: "ArtifactAuthoringError",
      status: 422,
    } satisfies Partial<ArtifactAuthoringError>);

    const [remaining] = await db.select().from(userUploads).where(eq(userUploads.id, input.id));
    expect(remaining?.runId).toBeNull();
    const rows = await db.select().from(artifacts).where(eq(artifacts.runId, runId));
    expect(rows).toHaveLength(0);
  });

  test("claims uploaded CSV in the artifact transaction and preserves original bytes", async () => {
    const runId = await sandboxRun();
    const source = Buffer.from("name,value\nlatency,42");
    const input = await upload({
      name: "metrics.csv",
      contentType: "text/csv; charset=utf-8",
      bytes: source,
    });

    const result = await createAuthoredArtifact({
      orgId: ORG,
      userId: USER,
      runId,
      kind: "spreadsheet",
      uploadId: input.id,
    });

    expect(result.created).toBe(true);
    expect(result.artifact.name).toBe("metrics.csv");
    expect(result.artifact.workpiece).toMatchObject({
      kind: "spreadsheet",
      actions: ARTIFACT_LEGACY_WORKPIECE_ACTIONS,
      exports: artifactWorkpieceExports("spreadsheet"),
      export_url: `/api/artifacts/${result.artifact.id}/workpiece/export`,
    });
    const [claimed] = await db.select().from(userUploads).where(eq(userUploads.id, input.id));
    expect(claimed?.runId).toBe(runId);
    const stored = await storage.read(result.artifact.sha256);
    expect(Buffer.from(stored).equals(source)).toBe(true);
    const events = await createdArtifactEvents(runId);
    expect(events).toHaveLength(1);
    await expect(createAuthoredArtifact({
      orgId: ORG,
      userId: USER,
      runId,
      kind: "spreadsheet",
      uploadId: input.id,
    })).rejects.toMatchObject({ code: "upload_unavailable" });
    expect(await db.select().from(artifacts).where(eq(artifacts.runId, runId))).toHaveLength(1);
    expect(await createdArtifactEvents(runId)).toHaveLength(1);
    expect(Buffer.from(await storage.read(result.artifact.sha256)).equals(source)).toBe(true);
  });

  test("emits one created event across idempotent authored replay", async () => {
    const runId = await sandboxRun();
    const input = {
      orgId: ORG,
      userId: USER,
      runId,
      kind: "document" as const,
      name: "release-notes.docx",
      state: { text: "# Release\nShip it" },
    };
    const first = await createAuthoredArtifact(input);
    expect(first.artifact.source_path).toStartWith("/.skynet/artifact-workspace/");
    const firstBytes = await storage.read(first.artifact.sha256);
    await db.update(artifacts)
      .set({ sourcePath: first.artifact.source_path.replace("/.skynet/", "/.useagent/") })
      .where(eq(artifacts.id, first.artifact.id));
    const [historical] = await db.select().from(artifacts).where(eq(artifacts.id, first.artifact.id));
    if (!historical) throw new Error("missing authored fixture");
    const canonicalReplay = await createAuthoredArtifact(input);
    expect(canonicalReplay.created).toBe(false);
    expect(canonicalReplay.artifact.id).toBe(first.artifact.id);
    expect(canonicalReplay.artifact.source_path).toBe(historical.sourcePath);
    expect(canonicalReplay.artifact.workpiece).toEqual(first.artifact.workpiece);
    expect(await storage.read(first.artifact.sha256)).toEqual(firstBytes);
    expect(await db.select().from(artifacts).where(eq(artifacts.sourcePath, historical.sourcePath)))
      .toHaveLength(1);
    expect(await createdArtifactEvents(runId)).toHaveLength(1);

    const second = await createArtifactRecord({
      orgId: historical.orgId,
      userId: historical.userId,
      runId: historical.runId,
      threadId: historical.threadId,
      sourcePath: historical.sourcePath,
      name: historical.name,
      contentType: historical.contentType,
      sizeBytes: historical.sizeBytes,
      sha256: "f".repeat(64),
      storageKey: "f".repeat(64),
      workpieceKind: historical.workpieceKind,
      workpieceState: historical.workpieceState,
    });
    expect(second.created).toBe(true);
    const replay = await createAuthoredArtifact(input);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect([first.artifact.id, second.row.id]).toContain(replay.artifact.id);
    expect(replay.artifact.source_path).toStartWith("/.useagent/artifact-workspace/");
    expect(replay.artifact.workpiece).toEqual(first.artifact.workpiece);
    expect(await db.select().from(artifacts).where(eq(artifacts.sourcePath, historical.sourcePath)))
      .toHaveLength(2);
    const events = await createdArtifactEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(`artifact.created:${first.artifact.id}`);
  });
});
