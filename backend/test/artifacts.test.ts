import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { executeArtifactTool } from "../src/knowledge/gateway/artifact-tools";
import { createRun, setRunSandbox } from "../src/runs/repo";
import { setSandboxDownloaderForTest } from "../src/slack/sandbox-file";
import { setArtifactStorageForTest } from "../src/artifacts/storage";
import { createOrgSession, fetchApi, json, type OrgSession } from "./helpers";
import { InMemoryArtifactStorage } from "./in-memory-artifact-storage";
import type { ArtifactDescriptor } from "../src/artifacts/repo";

const SOURCE_BYTES = new TextEncoder().encode("sandbox-to-browser\nexact bytes\n");
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
    { path },
  );
  if (result.isError) throw new Error(result.content.map((item) => item.text).join("\n"));
  const artifact = result.structuredContent?.artifact as ArtifactDescriptor | undefined;
  const created = result.structuredContent?.created;
  if (!artifact || typeof created !== "boolean") throw new Error("artifact tool returned no descriptor");
  return { artifact, created };
}

beforeAll(async () => {
  owner = await createOrgSession("artifact-owner");
  outsider = await createOrgSession("artifact-outsider");
  setArtifactStorageForTest(storage);
  setSandboxDownloaderForTest(async (_sandboxId, _path, maxBytes) => {
    if (SOURCE_BYTES.byteLength > maxBytes) throw new Error("test fixture exceeds cap");
    return { bytes: Buffer.from(SOURCE_BYTES), size: SOURCE_BYTES.byteLength };
  });
});

afterAll(() => {
  setSandboxDownloaderForTest(null);
  setArtifactStorageForTest(null);
});

describe("durable artifacts", () => {
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

  test("fails closed across organizations and for missing sandbox ownership", async () => {
    const runId = await createSandboxRun(owner);
    const published = await publish(owner, runId, "safe.txt");

    const outsideMetadata = await fetchApi(`/api/artifacts/${published.artifact.id}`, {
      cookies: outsider.cookies,
    });
    const outsideContent = await fetchApi(
      `/api/artifacts/${published.artifact.id}/content`,
      { cookies: outsider.cookies },
    );
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

    const invalid = await fetchApi(path, {
      cookies: owner.cookies,
      headers: { range: `bytes=${SOURCE_BYTES.byteLength}-` },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe(`bytes */${SOURCE_BYTES.byteLength}`);
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
