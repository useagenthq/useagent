import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import * as artifactFormats from "@skynet/artifact-formats";
import {
  csvToWorkbook,
  migrateHtmlToDocument,
  migrateSlidesToDeck,
} from "@skynet/artifact-workspace";
import type { ArtifactDescriptor } from "../src/artifacts/repo";
import { setArtifactStorageForTest } from "../src/artifacts/storage";
import { setOfficePreviewConverterForTest } from "../src/artifacts/office-preview";
import { executeArtifactTool } from "../src/knowledge/gateway/artifact-tools";
import { createRun, setRunSandbox } from "../src/runs/repo";
import { type OrgChange, subscribeOrg } from "../src/runs/org-signals";
import {
  setSandboxDownloaderForTest,
  setSandboxPathResolverForTest,
} from "../src/slack/sandbox-file";
import { deleteSecret, upsertSecret } from "../src/secrets/store";
import { createOrgSession, fetchApi, json, type OrgSession } from "./helpers";
import { InMemoryArtifactStorage } from "./in-memory-artifact-storage";

let sandboxBytes = new TextEncoder().encode("sandbox-to-browser\nexact bytes\n");
const SOURCE_BYTES = sandboxBytes;
const SHA256 = createHash("sha256").update(SOURCE_BYTES).digest("hex");
const storage = new InMemoryArtifactStorage();
let owner: OrgSession;
let outsider: OrgSession;

async function createSandboxRun(session: OrgSession): Promise<string> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "publish the report",
    model: "test",
    engine: "mock",
    orgId: session.orgId,
    userId: null,
    parentRunId: null,
    threadId: runId,
  });
  await setRunSandbox(runId, `sandbox-${runId}`);
  return runId;
}

async function publish(
  session: OrgSession,
  runId: string,
  path: string,
  args: Record<string, unknown> = {},
): Promise<{ artifact: ArtifactDescriptor; created: boolean }> {
  const result = await executeArtifactTool(
    {
      orgId: session.orgId,
      userId: session.email,
      threadId: runId,
      runId,
      exp: Date.now() + 60_000,
    },
    "artifact_publish",
    { path, ...args },
  );
  if (result.isError) throw new Error(result.content.map((item) => item.text).join("\n"));
  const artifact = result.structuredContent?.artifact as ArtifactDescriptor | undefined;
  const created = result.structuredContent?.created;
  if (!artifact || typeof created !== "boolean")
    throw new Error("artifact tool returned no descriptor");
  return { artifact, created };
}

beforeAll(async () => {
  owner = await createOrgSession("artifact-owner");
  outsider = await createOrgSession("artifact-outsider");
  setArtifactStorageForTest(storage);
  setSandboxDownloaderForTest(async (_sandboxId, _path, maxBytes) => {
    if (sandboxBytes.byteLength > maxBytes) throw new Error("test fixture exceeds cap");
    return { bytes: Buffer.from(sandboxBytes), size: sandboxBytes.byteLength };
  });
  // Office->PDF preview is off by default in tests (no live sandbox); the specific
  // preview test overrides this to assert the attach/serve path.
  setOfficePreviewConverterForTest(async () => null);
});

afterAll(() => {
  setSandboxDownloaderForTest(null);
  setSandboxPathResolverForTest(null);
  setOfficePreviewConverterForTest(null);
  setArtifactStorageForTest(null);
});

describe("durable artifacts", () => {
  test("rejects protected injected-secret paths and dotenv files before download", async () => {
    const runId = await createSandboxRun(owner);

    await expect(
      publish(owner, runId, "/root/.skynet/secrets/skynet-env.sh"),
    ).rejects.toThrow("Protected secret paths and dotenv files");
    await expect(
      publish(owner, runId, "/root/work/output/.env.local"),
    ).rejects.toThrow("Protected secret paths and dotenv files");
  });

  test("rejects relative paths, traversal, and workspace symlinks before download", async () => {
    const runId = await createSandboxRun(owner);
    const downloaded: string[] = [];
    setSandboxDownloaderForTest(async (_sandboxId, path) => {
      downloaded.push(path);
      return { bytes: Buffer.from(SOURCE_BYTES), size: SOURCE_BYTES.byteLength };
    });
    setSandboxPathResolverForTest(async (_sandboxId, path) =>
      path === "/root/work/output/dotenv-link"
        ? "/root/.skynet/secrets/skynet-env.sh"
        : path,
    );

    try {
      await expect(publish(owner, runId, ".skynet/secrets/skynet-env.sh")).rejects.toThrow(
        "canonical path under /root/work",
      );
      await expect(
        publish(owner, runId, "/root/work/../../etc/passwd"),
      ).rejects.toThrow("canonical path under /root/work");
      await expect(
        publish(owner, runId, "/root/work/output/dotenv-link"),
      ).rejects.toThrow("must not traverse or use a symlink");
      expect(downloaded).toEqual([]);

      const normal = await publish(owner, runId, "/root/work/output/report.txt");
      expect(normal.artifact.name).toBe("report.txt");
      expect(downloaded).toEqual(["/root/work/output/report.txt"]);
    } finally {
      setSandboxPathResolverForTest(null);
      setSandboxDownloaderForTest(async (_sandboxId, _path, maxBytes) => {
        if (sandboxBytes.byteLength > maxBytes) throw new Error("test fixture exceeds cap");
        return { bytes: Buffer.from(sandboxBytes), size: sandboxBytes.byteLength };
      });
    }
  });

  test("rejects artifact bytes containing a secret injected into the run sandbox", async () => {
    const runId = await createSandboxRun(owner);
    const secretName = "ARTIFACT_PUBLICATION_TEST_SECRET";
    const secretValue = `synthetic-secret-${crypto.randomUUID()}`;
    const previousBytes = sandboxBytes;
    await upsertSecret(owner.orgId, secretName, secretValue);
    sandboxBytes = new TextEncoder().encode(`safe prefix\n${secretValue}\nsafe suffix\n`);

    try {
      await expect(
        publish(owner, runId, "/root/work/output/report.txt"),
      ).rejects.toThrow("artifact content contains protected secret material");
    } finally {
      sandboxBytes = previousBytes;
      await deleteSecret(owner.orgId, secretName);
    }
  });

  test("rejects signed provider or tool capabilities copied into workspace output", async () => {
    const runId = await createSandboxRun(owner);
    const previousBytes = sandboxBytes;
    sandboxBytes = new TextEncoder().encode(
      "copied capability: v1.eyJvIjoib3JnIiwidCI6InRocmVhZCJ9.c2lnbmF0dXJlYnl0ZXM",
    );

    try {
      await expect(
        publish(owner, runId, "/root/work/output/report.txt"),
      ).rejects.toThrow("artifact content contains a signed runtime capability");
    } finally {
      sandboxBytes = previousBytes;
    }
  });

  test("serializes concurrent publication so a failed creator cannot erase the winner", async () => {
    class FirstPutFailsStorage extends InMemoryArtifactStorage {
      attempts = 0;

      override async put(key: string, bytes: Uint8Array): Promise<void> {
        this.attempts += 1;
        if (this.attempts === 1) {
          await Promise.resolve();
          throw new Error("injected first publication failure");
        }
        await super.put(key, bytes);
      }
    }

    const flaky = new FirstPutFailsStorage();
    const runId = await createSandboxRun(owner);
    setArtifactStorageForTest(flaky);
    try {
      const results = await Promise.allSettled([
        publish(owner, runId, "/root/work/output/concurrent.txt"),
        publish(owner, runId, "/root/work/output/concurrent.txt"),
      ]);
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof publish>>> =>
          result.status === "fulfilled",
      );
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(fulfilled).toHaveLength(1);
      const winner = fulfilled[0]?.value;
      expect(winner).toBeDefined();
      if (!winner) throw new Error("expected one successful artifact publication");
      expect(winner.created).toBe(true);
      expect(flaky.attempts).toBe(2);

      const content = await fetchApi(`/api/artifacts/${winner.artifact.id}/content`, {
        cookies: owner.cookies,
      });
      expect(content.status).toBe(200);
      expect(new Uint8Array(await content.arrayBuffer())).toEqual(SOURCE_BYTES);
    } finally {
      setArtifactStorageForTest(storage);
    }
  });

  test("publishes once and serves the exact bytes, metadata, HEAD, and ranges", async () => {
    const runId = await createSandboxRun(owner);
    const first = await publish(owner, runId, "/root/work/output/report.txt");
    expect(first.created).toBe(true);
    expect(first.artifact).toMatchObject({
      run_id: runId,
      thread_id: runId,
      name: "report.txt",
      content_type: "text/plain; charset=utf-8",
      size_bytes: SOURCE_BYTES.byteLength,
      sha256: SHA256,
      workpiece: {
        kind: "document",
        source_version: SHA256,
        state_revision: 0,
        actions: ["preview", "download", "edit"],
      },
    });

    const duplicate = await publish(owner, runId, "/root/work/output/report.txt");
    expect(duplicate.created).toBe(false);
    expect(duplicate.artifact.id).toBe(first.artifact.id);

    const contentPath = `/api/artifacts/${first.artifact.id}/content`;
    const content = await fetchApi(contentPath, { cookies: owner.cookies });
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(content.headers.get("content-disposition")).toContain("inline");
    expect(content.headers.get("etag")).toBe(`"sha256-${SHA256}"`);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(SOURCE_BYTES);

    const head = await fetchApi(contentPath, { method: "HEAD", cookies: owner.cookies });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(SOURCE_BYTES.byteLength));
    expect(await head.text()).toBe("");

    const range = await fetchApi(contentPath, {
      cookies: owner.cookies,
      headers: { range: "bytes=3-10" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 3-10/${SOURCE_BYTES.byteLength}`);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(SOURCE_BYTES.slice(3, 11));

    const listed = await json<{ artifacts: ArtifactDescriptor[] }>(
      `/api/artifacts?thread_id=${runId}`,
      { cookies: owner.cookies },
    );
    expect(listed.status).toBe(200);
    expect(listed.body.artifacts.map((artifact) => artifact.id)).toContain(first.artifact.id);
  });

  test("keeps private desktop inspection screenshots out of artifacts unless final proof is requested", async () => {
    const runId = await createSandboxRun(owner);
    const privatePath = "/root/work/screenshots/screenshot-1786558088313.png";

    const blocked = await executeArtifactTool(
      {
        orgId: owner.orgId,
        userId: owner.email,
        threadId: runId,
        runId,
        exp: Date.now() + 60_000,
      },
      "artifact_publish",
      { path: privatePath },
    );
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]?.text).toContain("Private desktop inspection screenshots");

    const daytonaBlocked = await executeArtifactTool(
      {
        orgId: owner.orgId,
        userId: owner.email,
        threadId: runId,
        runId,
        exp: Date.now() + 60_000,
      },
      "artifact_publish",
      { path: "/home/daytona/work/screenshots/screenshot-1786558088313.png" },
    );
    expect(daytonaBlocked.isError).toBe(true);

    const published = await publish(owner, runId, privatePath, {
      purpose: "user_requested_proof",
    });
    expect(published.created).toBe(true);
    expect(published.artifact.name).toBe("screenshot-1786558088313.png");

    const normalScreenshot = await publish(owner, runId, "/root/work/output/final-screen.png");
    expect(normalScreenshot.artifact.name).toBe("final-screen.png");
  });

  test("fails closed across organizations and for missing sandbox ownership", async () => {
    const runId = await createSandboxRun(owner);
    const published = await publish(owner, runId, "/root/work/safe.txt");

    const outsideMetadata = await fetchApi(`/api/artifacts/${published.artifact.id}`, {
      cookies: outsider.cookies,
    });
    const outsideContent = await fetchApi(`/api/artifacts/${published.artifact.id}/content`, {
      cookies: outsider.cookies,
    });
    expect(outsideMetadata.status).toBe(404);
    expect(outsideContent.status).toBe(404);

    const crossOrgPublish = await executeArtifactTool(
      {
        orgId: outsider.orgId,
        userId: outsider.email,
        threadId: runId,
        runId,
        exp: Date.now() + 60_000,
      },
      "artifact_publish",
      { path: "safe.txt" },
    );
    expect(crossOrgPublish.isError).toBe(true);

    const browserPublish = await fetchApi("/api/artifacts", {
      method: "POST",
      cookies: owner.cookies,
      body: { run_id: runId, path: "safe.txt" },
    });
    expect(browserPublish.status).toBe(400);
  });

  test("creates browser-authored native files with canonical export fallbacks", async () => {
    const runId = await createSandboxRun(owner);
    const created = await json<{ artifact: ArtifactDescriptor; created: boolean }>(
      "/api/artifacts",
      {
        method: "POST",
        cookies: owner.cookies,
        body: {
          run_id: runId,
          kind: "document",
          name: "launch brief.docx",
          state: { text: "# Launch brief\n\nReady for review" },
        },
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(true);
    expect(created.body.artifact).toMatchObject({
      name: "launch brief.docx",
      content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      workpiece: {
        kind: "document",
        exports: expect.arrayContaining([
          expect.objectContaining({ format: "docx", native: true }),
          expect.objectContaining({ format: "text", native: false }),
        ]),
      },
    });

    const native = await fetchApi(
      `/api/artifacts/${created.body.artifact.id}/workpiece/export`,
      { cookies: owner.cookies },
    );
    expect(native.status).toBe(200);
    expect(native.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(new Uint8Array(await native.arrayBuffer()).byteLength).toBeGreaterThan(1_000);

    const text = await fetchApi(
      `/api/artifacts/${created.body.artifact.id}/workpiece/export?format=text`,
      { cookies: owner.cookies },
    );
    expect(text.status).toBe(200);
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await text.text()).toContain("Ready for review");

    const invalidFormat = await json<{ error: string }>(
      `/api/artifacts/${created.body.artifact.id}/workpiece/export?format=zip`,
      { cookies: owner.cookies },
    );
    expect(invalidFormat).toEqual({
      status: 400,
      body: { error: "format must be one of: docx, html, text" },
    });
  });

  test("returns bounded 422 responses for render and extraction failures", async () => {
    const runId = await createSandboxRun(owner);
    const render = spyOn(artifactFormats, "renderArtifactExport")
      .mockRejectedValue(new Error("sensitive renderer internals"));
    let renderFailure: Awaited<ReturnType<typeof json<{ error: string }>>>;
    try {
      renderFailure = await json<{ error: string }>("/api/artifacts", {
        method: "POST",
        cookies: owner.cookies,
        body: {
          run_id: runId,
          kind: "pdf",
          name: "render-failure.pdf",
          state: { pdfText: "Ready" },
        },
      });
    } finally {
      render.mockRestore();
    }
    expect(renderFailure).toEqual({
      status: 422,
      body: { error: "artifact export could not be rendered" },
    });

    const form = new FormData();
    form.append("file", new File(
      ["not a docx container"],
      "broken.docx",
      { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    ));
    const uploaded = await json<{ upload: { id: string } }>("/api/uploads", {
      method: "POST",
      cookies: owner.cookies,
      body: form,
    });
    expect(uploaded.status).toBe(201);

    try {
      const extractionFailure = await json<{ error: string }>("/api/artifacts", {
        method: "POST",
        cookies: owner.cookies,
        body: {
          run_id: runId,
          kind: "document",
          upload_id: uploaded.body.upload.id,
        },
      });
      expect(extractionFailure).toEqual({
        status: 422,
        body: { error: "uploaded document could not be extracted" },
      });
    } finally {
      const removed = await fetchApi(`/api/uploads/${uploaded.body.upload.id}`, {
        method: "DELETE",
        cookies: owner.cookies,
      });
      expect(removed.status).toBe(204);
    }
  });

  test("rejects invalid ranges and active content is attachment-only", async () => {
    const runId = await createSandboxRun(owner);
    const published = await publish(owner, runId, "/root/work/unsafe.html");
    const path = `/api/artifacts/${published.artifact.id}/content`;

    const content = await fetchApi(path, { cookies: owner.cookies });
    expect(content.headers.get("content-disposition")).toContain("attachment");

    const metadata = await json<{ artifact: ArtifactDescriptor }>(
      `/api/artifacts/${published.artifact.id}`,
      { cookies: owner.cookies },
    );
    expect(metadata.body.artifact.workpiece).toBeNull();

    const invalid = await fetchApi(path, {
      cookies: owner.cookies,
      headers: { range: `bytes=${SOURCE_BYTES.byteLength}-` },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe(`bytes */${SOURCE_BYTES.byteLength}`);
  });

  test("persists typed workpiece state with optimistic concurrency and tenant isolation", async () => {
    const runId = await createSandboxRun(owner);
    const published = await publish(owner, runId, "/root/work/notes.md");
    const path = `/api/artifacts/${published.artifact.id}/workpiece`;

    const initial = await json<{
      workpiece: NonNullable<ArtifactDescriptor["workpiece"]>;
      state: { text: string };
    }>(path, { cookies: owner.cookies });
    expect(initial.status).toBe(200);
    expect(initial.body.workpiece).toMatchObject({
      kind: "document",
      source_version: SHA256,
      state_revision: 0,
    });
    expect(initial.body.state).toEqual({ text: "sandbox-to-browser\nexact bytes\n" });

    const updated = await json<{
      workpiece: NonNullable<ArtifactDescriptor["workpiece"]>;
      state: { text: string };
    }>(path, {
      method: "PATCH",
      cookies: owner.cookies,
      body: { expected_revision: 0, state: { text: "edited in Skynet" } },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.workpiece.state_revision).toBe(1);
    expect(updated.body.state).toEqual({ text: "edited in Skynet" });

    const stale = await fetchApi(path, {
      method: "PATCH",
      cookies: owner.cookies,
      body: { expected_revision: 0, state: { text: "stale overwrite" } },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "revision conflict",
      workpiece: { state_revision: 1 },
      state: { text: "edited in Skynet" },
    });

    const outside = await fetchApi(path, { cookies: outsider.cookies });
    expect(outside.status).toBe(404);
  });

  test("exposes bounded Office files as companion workpieces without mutating bytes", async () => {
    const runId = await createSandboxRun(owner);
    const docx = await publish(owner, runId, "/root/work/brief.docx");
    const xlsx = await publish(owner, runId, "/root/work/model.xlsx");

    expect(docx.artifact.workpiece).toMatchObject({ kind: "document", state_revision: 0 });
    expect(xlsx.artifact.workpiece).toMatchObject({ kind: "spreadsheet", state_revision: 0 });

    const documentPath = `/api/artifacts/${docx.artifact.id}/workpiece`;
    // A v1 { html } PATCH is upgraded to the themed v2 { document } on the wire.
    const savedHtml = await json<{ state: unknown }>(documentPath, {
      method: "PATCH",
      cookies: owner.cookies,
      body: { expected_revision: 0, state: { html: "<h1>Brief</h1><p>Edited</p>" } },
    });
    expect(savedHtml.status).toBe(200);
    expect(savedHtml.body.state).toEqual({
      document: migrateHtmlToDocument("<h1>Brief</h1><p>Edited</p>"),
    });

    const rejectedHtml = await json(documentPath, {
      method: "PATCH",
      cookies: owner.cookies,
      body: { expected_revision: 1, state: { html: "<img src=x onerror=alert(1)>" } },
    });
    expect(rejectedHtml.status).toBe(400);

    const sheetPath = `/api/artifacts/${xlsx.artifact.id}/workpiece`;
    // A v1 { csv } PATCH is upgraded to the canonical v2 { workbook } on the wire.
    const savedCsv = await json<{ state: unknown }>(sheetPath, {
      method: "PATCH",
      cookies: owner.cookies,
      body: { expected_revision: 0, state: { csv: "name,value\nrun,42" } },
    });
    expect(savedCsv.status).toBe(200);
    expect(savedCsv.body.state).toEqual({ workbook: csvToWorkbook("name,value\nrun,42") });

    const content = await fetchApi(`/api/artifacts/${docx.artifact.id}/content`, {
      cookies: owner.cookies,
    });
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(SOURCE_BYTES);
  });

  test("seeds Office workpieces from explicit editable companions", async () => {
    const runId = await createSandboxRun(owner);
    const source = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const html = new TextEncoder().encode("<h1>Launch brief</h1><p>Ready to edit</p>");
    const alternateHtml = new TextEncoder().encode("<h1>Different brief</h1>");
    const csv = new TextEncoder().encode("metric,value\nlatency_ms,4200\n");
    setSandboxDownloaderForTest(async (_sandboxId, path, maxBytes) => {
      const bytes = path.endsWith("alternate.html")
        ? alternateHtml
        : path.endsWith(".html")
          ? html
          : path.endsWith(".csv")
            ? csv
            : source;
      if (bytes.byteLength > maxBytes) throw new Error("test fixture exceeds cap");
      return { bytes: Buffer.from(bytes), size: bytes.byteLength };
    });
    try {
      const claims = {
        orgId: owner.orgId,
        userId: owner.email,
        threadId: runId,
        runId,
        exp: Date.now() + 60_000,
      };
      const initialDoc = await executeArtifactTool(claims, "artifact_publish", {
        path: "/root/work/brief.docx",
      });
      const doc = await executeArtifactTool(claims, "artifact_publish", {
        path: "/root/work/brief.docx",
        editable_path: "/root/work/brief.html",
      });
      const sheet = await executeArtifactTool(claims, "artifact_publish", {
        path: "/root/work/metrics.xlsx",
        editable_path: "/root/work/metrics.csv",
      });
      expect(initialDoc.isError).toBeFalsy();
      expect(doc.isError).toBeFalsy();
      expect(sheet.isError).toBeFalsy();

      const initialDocArtifact = initialDoc.structuredContent?.artifact as ArtifactDescriptor;
      const docArtifact = doc.structuredContent?.artifact as ArtifactDescriptor;
      const sheetArtifact = sheet.structuredContent?.artifact as ArtifactDescriptor;
      expect(docArtifact.id).toBe(initialDocArtifact.id);
      expect(doc.structuredContent?.created).toBe(false);
      const docState = await json<{ state: unknown }>(
        `/api/artifacts/${docArtifact.id}/workpiece`,
        { cookies: owner.cookies },
      );
      const sheetState = await json<{ state: unknown }>(
        `/api/artifacts/${sheetArtifact.id}/workpiece`,
        { cookies: owner.cookies },
      );
      expect(docState.body.state).toEqual({
        document: migrateHtmlToDocument(new TextDecoder().decode(html)),
      });
      expect(sheetState.body.state).toEqual({
        workbook: csvToWorkbook(new TextDecoder().decode(csv)),
      });

      const conflictingDoc = await executeArtifactTool(claims, "artifact_publish", {
        path: "/root/work/brief.docx",
        editable_path: "/root/work/alternate.html",
      });
      expect(conflictingDoc.isError).toBe(true);
      expect(conflictingDoc.content[0]?.text).toContain("editable companion conflicts");
    } finally {
      setSandboxDownloaderForTest(async (_sandboxId, _path, maxBytes) => {
        if (sandboxBytes.byteLength > maxBytes) throw new Error("test fixture exceeds cap");
        return { bytes: Buffer.from(sandboxBytes), size: sandboxBytes.byteLength };
      });
    }
  });

  test("republishes a regenerated file as a new revision of the same artifact", async () => {
    const runId = await createSandboxRun(owner);
    const v1 = new TextEncoder().encode("Version one\n");
    const v2 = new TextEncoder().encode("Version two, regenerated\n");
    setSandboxDownloaderForTest(async (_sandboxId, path, maxBytes) => {
      const bytes = path.includes("v2") ? v2 : v1;
      if (bytes.byteLength > maxBytes) throw new Error("test fixture exceeds cap");
      return { bytes: Buffer.from(bytes), size: bytes.byteLength };
    });
    try {
      const first = await publish(owner, runId, "/root/work/report-v1.txt", { name: "report.txt" });
      expect(first.created).toBe(true);
      expect(first.artifact.workpiece).toMatchObject({ kind: "document", state_revision: 0 });

      // A republish lands as a NEW REVISION of the SAME artifact (one tab, history).
      const revised = await publish(owner, runId, "/root/work/report-v2.txt", {
        name: "report.txt",
        updates_artifact_id: first.artifact.id,
      });
      expect(revised.created).toBe(false);
      expect(revised.artifact.id).toBe(first.artifact.id);
      expect(revised.artifact.workpiece?.state_revision).toBe(1);

      // The content bytes and the editable state both reflect the regenerated file.
      const content = await fetchApi(`/api/artifacts/${first.artifact.id}/content`, {
        cookies: owner.cookies,
      });
      expect(new Uint8Array(await content.arrayBuffer())).toEqual(v2);
      const state = await json<{ state: unknown }>(
        `/api/artifacts/${first.artifact.id}/workpiece`,
        { cookies: owner.cookies },
      );
      expect(state.body.state).toEqual({ text: "Version two, regenerated\n" });

      // A kind mismatch is rejected: an xlsx cannot revise a document artifact.
      const mismatch = await executeArtifactTool(
        { orgId: owner.orgId, userId: owner.email, threadId: runId, runId, exp: Date.now() + 60_000 },
        "artifact_publish",
        { path: "/root/work/model-v1.xlsx", updates_artifact_id: first.artifact.id },
      );
      expect(mismatch.isError).toBe(true);
      expect(mismatch.content[0]?.text).toContain("does not match");

      // Cross-org isolation: another org cannot revise this artifact.
      const foreign = await executeArtifactTool(
        {
          orgId: outsider.orgId,
          userId: outsider.email,
          threadId: runId,
          runId,
          exp: Date.now() + 60_000,
        },
        "artifact_publish",
        { path: "/root/work/report-v2.txt", updates_artifact_id: first.artifact.id },
      );
      expect(foreign.isError).toBe(true);
    } finally {
      setSandboxDownloaderForTest(async (_sandboxId, _path, maxBytes) => {
        if (sandboxBytes.byteLength > maxBytes) throw new Error("test fixture exceeds cap");
        return { bytes: Buffer.from(sandboxBytes), size: sandboxBytes.byteLength };
      });
    }
  });

  test("a republish conflicts a proposal authored against the older revision", async () => {
    const runId = await createSandboxRun(owner);
    const v1 = new TextEncoder().encode("Brief version one\n");
    const v2 = new TextEncoder().encode("Brief version two\n");
    setSandboxDownloaderForTest(async (_sandboxId, path, maxBytes) => {
      const bytes = path.includes("v2") ? v2 : v1;
      if (bytes.byteLength > maxBytes) throw new Error("test fixture exceeds cap");
      return { bytes: Buffer.from(bytes), size: bytes.byteLength };
    });
    try {
      const claims = {
        orgId: owner.orgId,
        userId: owner.email,
        threadId: runId,
        runId,
        exp: Date.now() + 60_000,
      };
      const doc = await publish(owner, runId, "/root/work/brief-v1.txt", { name: "brief.txt" });

      // An agent proposes an edit against mainline revision 0.
      const proposed = await executeArtifactTool(claims, "workpiece_propose_edit", {
        artifact_id: doc.artifact.id,
        state: { text: "Proposed edit body\n" },
        summary: "tweak wording",
      });
      expect(proposed.isError).toBeFalsy();
      const proposalId = proposed.structuredContent?.proposal_id as string;

      // A republish advances mainline to revision 1 (a plain mainline advance).
      const revised = await publish(owner, runId, "/root/work/brief-v2.txt", {
        name: "brief.txt",
        updates_artifact_id: doc.artifact.id,
      });
      expect(revised.artifact.workpiece?.state_revision).toBe(1);

      // Accepting the proposal now 409s: it was authored against the old revision,
      // exactly like accepting after a human save (existing conflict handling).
      const accept = await fetchApi(
        `/api/artifacts/${doc.artifact.id}/proposals/${proposalId}/accept`,
        { method: "POST", cookies: owner.cookies },
      );
      expect(accept.status).toBe(409);

      // Mainline still shows the republished bytes, not the proposed edit.
      const state = await json<{ state: unknown }>(
        `/api/artifacts/${doc.artifact.id}/workpiece`,
        { cookies: owner.cookies },
      );
      expect(state.body.state).toEqual({ text: "Brief version two\n" });
    } finally {
      setSandboxDownloaderForTest(async (_sandboxId, _path, maxBytes) => {
        if (sandboxBytes.byteLength > maxBytes) throw new Error("test fixture exceeds cap");
        return { bytes: Buffer.from(sandboxBytes), size: sandboxBytes.byteLength };
      });
    }
  });

  test("attaches and serves a rendered PDF preview for a published Office binary", async () => {
    const runId = await createSandboxRun(owner);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
    const previous = sandboxBytes;
    try {
      sandboxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x66, 0x61, 0x6b, 0x65]); // PK.. (office-ish)

      // Success: the converter yields a PDF, so the artifact carries a preview URL
      // and the preview route serves those exact bytes as application/pdf.
      setOfficePreviewConverterForTest(async () => pdf);
      const deck = await publish(owner, runId, "/root/work/slides.pptx");
      expect(deck.artifact.preview_pdf_url).toBe(`/api/artifacts/${deck.artifact.id}/preview`);
      const preview = await fetchApi(`/api/artifacts/${deck.artifact.id}/preview`, {
        cookies: owner.cookies,
      });
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-type")).toBe("application/pdf");
      expect(new Uint8Array(await preview.arrayBuffer())).toEqual(pdf);
      // Org-scoped: another org cannot read the preview.
      const foreign = await fetchApi(`/api/artifacts/${deck.artifact.id}/preview`, {
        cookies: outsider.cookies,
      });
      expect(foreign.status).toBe(404);

      // A failed conversion is silent: no preview URL, download-only as before.
      setOfficePreviewConverterForTest(async () => null);
      const doc = await publish(owner, runId, "/root/work/report.docx");
      expect(doc.artifact.preview_pdf_url).toBeNull();
      const missing = await fetchApi(`/api/artifacts/${doc.artifact.id}/preview`, {
        cookies: owner.cookies,
      });
      expect(missing.status).toBe(404);

      // A non-Office file is never converted (the converter is not even consulted).
      setOfficePreviewConverterForTest(async () => pdf);
      const txt = await publish(owner, runId, "/root/work/notes.txt");
      expect(txt.artifact.preview_pdf_url).toBeNull();
    } finally {
      setOfficePreviewConverterForTest(async () => null);
      sandboxBytes = previous;
    }
  });

  test("workpiece_create authors a native workpiece and fires the created auto-open signal", async () => {
    const runId = await createSandboxRun(owner);
    const claims = {
      orgId: owner.orgId,
      userId: owner.email,
      threadId: runId,
      runId,
      exp: Date.now() + 60_000,
    };
    const created: OrgChange[] = [];
    const unsubscribe = subscribeOrg(owner.orgId, (change) => {
      if (change.type === "artifact" && change.action === "created") created.push(change);
    });
    try {
      const res = await executeArtifactTool(claims, "workpiece_create", {
        kind: "presentation",
        name: "Pitch.pptx",
        state: { deck: migrateSlidesToDeck([{ title: "Intro", body: "Hello" }]) },
        summary: "first draft",
      });
      expect(res.isError).toBeFalsy();
      const artifact = res.structuredContent?.artifact as ArtifactDescriptor;
      expect(artifact.workpiece).toMatchObject({ kind: "presentation" });
      // The created signal (what auto-opens the pane) fired for this artifact.
      expect(
        created.some((c) => c.type === "artifact" && c.artifactId === artifact.id),
      ).toBe(true);

      // Persisted and openable via the workpiece route with the canonical deck.
      const wp = await json<{ workpiece: { kind: string }; state: { deck?: unknown } }>(
        `/api/artifacts/${artifact.id}/workpiece`,
        { cookies: owner.cookies },
      );
      expect(wp.status).toBe(200);
      expect(wp.body.workpiece.kind).toBe("presentation");
      expect(wp.body.state.deck).toBeDefined();

      // The MCP schema exposes the same color shorthand as presentations. The
      // document boundary canonicalizes it instead of rejecting the authoring call.
      const documentRes = await executeArtifactTool(claims, "workpiece_create", {
        kind: "document",
        name: "Brief.docx",
        state: {
          document: {
            schemaVersion: 2,
            theme: {
              background: "#101828",
              heading: "#ffffff",
              body: "#d0d5dd",
              accent: "#ffcc66",
            },
            html: "<h1>Brief</h1><p>Exact production shorthand.</p>",
          },
        },
      });
      expect(documentRes.isError).toBeFalsy();
      const documentArtifact = documentRes.structuredContent?.artifact as ArtifactDescriptor;
      const documentState = await json<{
        state: { document: { theme: { background: unknown } } };
      }>(`/api/artifacts/${documentArtifact.id}/workpiece`, { cookies: owner.cookies });
      expect(documentState.body.state.document.theme.background).toEqual({
        type: "color",
        color: "#101828",
      });

      // Invalid state for the kind is rejected with a helpful message.
      const bad = await executeArtifactTool(claims, "workpiece_create", {
        kind: "spreadsheet",
        name: "broken.xlsx",
        state: { deck: { nope: true } },
      });
      expect(bad.isError).toBe(true);
      expect(bad.content[0]?.text).toContain("Could not create");

      // An unknown kind is rejected before any authoring.
      const badKind = await executeArtifactTool(claims, "workpiece_create", {
        kind: "movie",
        name: "x.mp4",
        state: { text: "x" },
      });
      expect(badKind.isError).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  test("artifact_publish natively imports a companion-less PPTX into an editable deck", async () => {
    const runId = await createSandboxRun(owner);
    const deck = {
      schemaVersion: 2 as const,
      theme: {
        background: { type: "color" as const, color: "#101828" },
        heading: "#ffffff",
        body: "#c8c8e0",
        accent: "#5eb0ff",
      },
      slides: [
        {
          id: "s1",
          background: { type: "color" as const, color: "#0b1220" },
          blocks: [
            {
              id: "h",
              type: "heading" as const,
              x: 6,
              y: 8,
              w: 88,
              h: 17,
              content: "Native Deck",
              style: { fontSize: 96, bold: true, align: "left" as const, color: "#ffd166" },
            },
            {
              id: "b",
              type: "text" as const,
              x: 6,
              y: 30,
              w: 88,
              h: 50,
              content: "Converged on arrival",
              style: { fontSize: 44, align: "left" as const, color: "#c8c8e0" },
            },
          ],
        },
      ],
    };
    const pptx = await artifactFormats.renderArtifactExport({ deck }, "pptx");
    const previous = sandboxBytes;
    try {
      sandboxBytes = pptx.bytes;
      const published = await publish(owner, runId, "/root/work/pitch.pptx");
      expect(published.artifact.workpiece).toMatchObject({ kind: "presentation" });

      // Converged to an editable native deck instead of a download-only card.
      const wp = await json<{ state: { deck?: { slides: { blocks: { content: string }[] }[] } } }>(
        `/api/artifacts/${published.artifact.id}/workpiece`,
        { cookies: owner.cookies },
      );
      expect(wp.status).toBe(200);
      expect(wp.body.state.deck).toBeDefined();
      expect(wp.body.state.deck!.slides).toHaveLength(1);
      const contents = wp.body.state.deck!.slides[0]!.blocks.map((block) => block.content);
      expect(contents).toContain("Native Deck");
      expect(contents).toContain("Converged on arrival");
    } finally {
      sandboxBytes = previous;
    }
  });

  test("artifact_publish maps a full-slide PPTX picture to the deck background and dedupes assets", async () => {
    const runId = await createSandboxRun(owner);
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "DECK", width: 10, height: 5.625 });
    pptx.layout = "DECK";
    const slide = pptx.addSlide();
    slide.addText("With Art", { x: 0.5, y: 0.4, w: 8, h: 1, fontSize: 40 });
    slide.addImage({ data: `image/png;base64,${png}`, x: 0, y: 0, w: 10, h: 5.625 }); // background art
    slide.addImage({ data: `image/png;base64,${png}`, x: 1, y: 2, w: 3, h: 2 }); // positioned block
    const written = await pptx.write({ outputType: "nodebuffer" });
    const pptxBytes = written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBuffer);

    const previous = sandboxBytes;
    try {
      sandboxBytes = pptxBytes;
      const published = await publish(owner, runId, "/root/work/art.pptx");
      const wp = await json<{
        state: {
          deck?: {
            slides: {
              background?: { type: string; url?: string };
              blocks: { type: string; content: string }[];
            }[];
          };
        };
      }>(`/api/artifacts/${published.artifact.id}/workpiece`, { cookies: owner.cookies });
      expect(wp.status).toBe(200);
      const deckSlide = wp.body.state.deck!.slides[0]!;

      // The full-slide picture became the slide's background image.
      expect(deckSlide.background?.type).toBe("image");
      expect(deckSlide.background!.url).toMatch(/^\/api\/artifacts\/[^/]+\/content$/);
      // The smaller picture became a positioned image block.
      const imageBlock = deckSlide.blocks.find((block) => block.type === "image");
      expect(imageBlock).toBeDefined();
      expect(imageBlock!.content).toMatch(/^\/api\/artifacts\/[^/]+\/content$/);

      // Both pictures are the same PNG bytes, so org content-addressed dedup points
      // them at ONE image artifact - no duplicate.
      expect(imageBlock!.content).toBe(deckSlide.background!.url);

      // The referenced image artifact serves the real embedded bytes.
      const imageId = imageBlock!.content.split("/")[3]!;
      const content = await fetchApi(`/api/artifacts/${imageId}/content`, { cookies: owner.cookies });
      expect(content.status).toBe(200);
      expect(content.headers.get("content-type")).toContain("image/png");
      expect((await content.arrayBuffer()).byteLength).toBeGreaterThan(0);
    } finally {
      sandboxBytes = previous;
    }
  });

  test("keeps over-limit Office binaries download-only", async () => {
    const runId = await createSandboxRun(owner);
    const previous = sandboxBytes;
    try {
      sandboxBytes = new Uint8Array(10_000_001);
      const published = await publish(owner, runId, "/root/work/huge.xlsx");
      expect(published.artifact.workpiece).toBeNull();
    } finally {
      sandboxBytes = previous;
    }
  });

  test("packages a run's published artifacts into one downloadable ZIP", async () => {
    const runId = await createSandboxRun(owner);
    const report = await publish(owner, runId, "/root/work/output/report.txt");
    const summary = await publish(owner, runId, "/root/work/output/summary.md");
    expect(report.created).toBe(true);
    expect(summary.created).toBe(true);

    const archive = await fetchApi(`/api/artifacts/runs/${runId}/archive`, {
      cookies: owner.cookies,
    });
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/zip");
    expect(archive.headers.get("content-disposition")).toContain(`run-${runId}-artifacts.zip`);

    const zip = await JSZip.loadAsync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(zip.files).toSorted()).toEqual(["report.txt", "summary.md"]);
    expect(await zip.file("report.txt")?.async("uint8array")).toEqual(SOURCE_BYTES);

    // A run with no artifacts has nothing to archive.
    const emptyRun = await createSandboxRun(owner);
    const empty = await fetchApi(`/api/artifacts/runs/${emptyRun}/archive`, {
      cookies: owner.cookies,
    });
    expect(empty.status).toBe(404);

    // Tenant isolation: another org sees none of the run's artifacts.
    const outside = await fetchApi(`/api/artifacts/runs/${runId}/archive`, {
      cookies: outsider.cookies,
    });
    expect(outside.status).toBe(404);
  });

  test("encodes non-ASCII and reserved filename characters safely", async () => {
    const runId = await createSandboxRun(owner);
    const published = await publish(owner, runId, "/root/work/report (final)' é.txt");
    const content = await fetchApi(`/api/artifacts/${published.artifact.id}/content`, {
      cookies: owner.cookies,
    });
    const header = content.headers.get("content-disposition") ?? "";
    expect(header).toContain("filename*=UTF-8''report%20%28final%29%27%20%C3%A9.txt");
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
  });
});
