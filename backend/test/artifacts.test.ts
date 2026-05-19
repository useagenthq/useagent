import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ArtifactDescriptor } from "../src/artifacts/repo";
import { setArtifactStorageForTest } from "../src/artifacts/storage";
import { executeArtifactTool } from "../src/knowledge/gateway/artifact-tools";
import { createRun, setRunSandbox } from "../src/runs/repo";
import { setSandboxDownloaderForTest } from "../src/slack/sandbox-file";
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
});

afterAll(() => {
  setSandboxDownloaderForTest(null);
  setArtifactStorageForTest(null);
});

describe("durable artifacts", () => {
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
    const published = await publish(owner, runId, "safe.txt");

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
    expect(browserPublish.status).toBe(404);
  });

  test("rejects invalid ranges and active content is attachment-only", async () => {
    const runId = await createSandboxRun(owner);
    const published = await publish(owner, runId, "unsafe.html");
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
    const published = await publish(owner, runId, "notes.md");
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
    const docx = await publish(owner, runId, "brief.docx");
    const xlsx = await publish(owner, runId, "model.xlsx");

    expect(docx.artifact.workpiece).toMatchObject({ kind: "document", state_revision: 0 });
    expect(xlsx.artifact.workpiece).toMatchObject({ kind: "spreadsheet", state_revision: 0 });

    const documentPath = `/api/artifacts/${docx.artifact.id}/workpiece`;
    const savedHtml = await json<{ state: { html: string } }>(documentPath, {
      method: "PATCH",
      cookies: owner.cookies,
      body: { expected_revision: 0, state: { html: "<h1>Brief</h1><p>Edited</p>" } },
    });
    expect(savedHtml.status).toBe(200);
    expect(savedHtml.body.state).toEqual({ html: "<h1>Brief</h1><p>Edited</p>" });

    const rejectedHtml = await json(documentPath, {
      method: "PATCH",
      cookies: owner.cookies,
      body: { expected_revision: 1, state: { html: "<img src=x onerror=alert(1)>" } },
    });
    expect(rejectedHtml.status).toBe(400);

    const sheetPath = `/api/artifacts/${xlsx.artifact.id}/workpiece`;
    const savedCsv = await json<{ state: { csv: string } }>(sheetPath, {
      method: "PATCH",
      cookies: owner.cookies,
      body: { expected_revision: 0, state: { csv: "name,value\nrun,42" } },
    });
    expect(savedCsv.status).toBe(200);
    expect(savedCsv.body.state).toEqual({ csv: "name,value\nrun,42" });

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
      const docState = await json<{ state: { html: string } }>(
        `/api/artifacts/${docArtifact.id}/workpiece`,
        { cookies: owner.cookies },
      );
      const sheetState = await json<{ state: { csv: string } }>(
        `/api/artifacts/${sheetArtifact.id}/workpiece`,
        { cookies: owner.cookies },
      );
      expect(docState.body.state).toEqual({ html: new TextDecoder().decode(html) });
      expect(sheetState.body.state).toEqual({ csv: new TextDecoder().decode(csv) });

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

  test("keeps over-limit Office binaries download-only", async () => {
    const runId = await createSandboxRun(owner);
    const previous = sandboxBytes;
    try {
      sandboxBytes = new Uint8Array(10_000_001);
      const published = await publish(owner, runId, "huge.xlsx");
      expect(published.artifact.workpiece).toBeNull();
    } finally {
      sandboxBytes = previous;
    }
  });

  test("encodes non-ASCII and reserved filename characters safely", async () => {
    const runId = await createSandboxRun(owner);
    const published = await publish(owner, runId, "report (final)' é.txt");
    const content = await fetchApi(`/api/artifacts/${published.artifact.id}/content`, {
      cookies: owner.cookies,
    });
    const header = content.headers.get("content-disposition") ?? "";
    expect(header).toContain("filename*=UTF-8''report%20%28final%29%27%20%C3%A9.txt");
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
  });
});
