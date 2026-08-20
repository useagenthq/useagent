import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setArtifactStorageForTest } from "../src/artifacts/storage";
import { db } from "../src/db/client";
import { userUploads } from "../src/db/schema";
import { InMemoryArtifactStorage } from "./in-memory-artifact-storage";
import {
  createOrgSession,
  fetchApi,
  json,
  type OrgSession,
  waitFor,
} from "./helpers";

const storage = new InMemoryArtifactStorage();
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
let owner: OrgSession;
let outsider: OrgSession;

/** Upload a PNG, then create a run that atomically claims it. Returns the ids. */
async function runWithAttachment(
  session: OrgSession,
  contentType = "image/png",
): Promise<{ runId: string; uploadId: string }> {
  const form = new FormData();
  form.set("file", new File([image], "diagram.png", { type: contentType }));
  const uploaded = await fetchApi("/api/uploads", {
    method: "POST",
    cookies: session.cookies,
    body: form,
  });
  expect(uploaded.status).toBe(201);
  const { upload } = (await uploaded.json()) as { upload: { id: string } };

  const accepted = await json<{ id: string }>("/api/runs", {
    method: "POST",
    cookies: session.cookies,
    body: { prompt: "describe the attached image", attachments: [upload.id] },
  });
  expect(accepted.status).toBe(201);
  return { runId: accepted.body.id, uploadId: upload.id };
}

beforeAll(async () => {
  owner = await createOrgSession("run-uploads-owner");
  outsider = await createOrgSession("run-uploads-outsider");
  setArtifactStorageForTest(storage);
});

afterAll(() => {
  setArtifactStorageForTest(null);
});

describe("a run's inbound uploads in the timeline payload", () => {
  test("the run + thread payload carries a compact uploads array", async () => {
    const { runId, uploadId } = await runWithAttachment(owner);

    const run = await json<{ uploads: Array<Record<string, unknown>> }>(`/api/runs/${runId}`, {
      cookies: owner.cookies,
    });
    expect(run.status).toBe(200);
    expect(run.body.uploads).toHaveLength(1);
    const u = run.body.uploads[0]!;
    expect(u.id).toBe(uploadId);
    expect(u.name).toBe("diagram.png");
    expect(u.content_type).toBe("image/png");
    expect(u.size_bytes).toBe(image.byteLength);
    // Compact descriptor only - no storage key / sha / expiry leaks to the wire.
    expect(u).not.toHaveProperty("storage_key");
    expect(u).not.toHaveProperty("sha256");
    expect(u).not.toHaveProperty("download_url");

    const thread = await json<{ thread: Array<{ id: string; uploads: unknown[] }> }>(
      `/api/runs/${runId}?thread=1`,
      { cookies: owner.cookies },
    );
    expect(thread.status).toBe(200);
    const threadRun = thread.body.thread.find((r) => r.id === runId);
    expect(threadRun?.uploads).toHaveLength(1);
  });

  test("a run with no attachment reports an empty uploads array", async () => {
    const accepted = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: owner.cookies,
      body: { prompt: "no attachment here" },
    });
    expect(accepted.status).toBe(201);
    const run = await json<{ uploads: unknown[] }>(`/api/runs/${accepted.body.id}`, {
      cookies: owner.cookies,
    });
    expect(run.body.uploads).toEqual([]);
  });
});

describe("GET /api/runs/:id/uploads (list route)", () => {
  test("lists a run's inbound uploads for the owning org", async () => {
    const { runId, uploadId } = await runWithAttachment(owner);
    const res = await json<{ uploads: Array<{ id: string }> }>(`/api/runs/${runId}/uploads`, {
      cookies: owner.cookies,
    });
    expect(res.status).toBe(200);
    expect(res.body.uploads.map((u) => u.id)).toEqual([uploadId]);
  });

  test("404s for a cross-org run id (indistinguishable from missing)", async () => {
    const { runId } = await runWithAttachment(owner);
    const res = await json<{ error: string }>(`/api/runs/${runId}/uploads`, {
      cookies: outsider.cookies,
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/uploads/:id/content for a claimed upload", () => {
  test("serves the exact bytes to the owner and 404s a cross-org viewer", async () => {
    const { uploadId } = await runWithAttachment(owner);
    const content = await fetchApi(`/api/uploads/${uploadId}/content`, {
      cookies: owner.cookies,
    });
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(image);

    const cross = await fetchApi(`/api/uploads/${uploadId}/content`, {
      cookies: outsider.cookies,
    });
    expect(cross.status).toBe(404);
  });

  test("a claimed upload is readable org-wide, not only by its uploader", async () => {
    // Simulate a teammate's inbound attachment: same org, a DIFFERENT user id,
    // already claimed by a run. The org-scoped read must serve it so anyone
    // viewing the thread sees the image (matching the artifact content route).
    const { runId, uploadId } = await runWithAttachment(owner);
    await db
      .update(userUploads)
      .set({ userId: `other-member-${crypto.randomUUID()}` })
      .where(eq(userUploads.id, uploadId));

    // Wait for the run to settle so the reassigned owner-check has no bearing.
    await waitFor(async () => {
      const run = await json<{ status: string }>(`/api/runs/${runId}`, {
        cookies: owner.cookies,
      });
      return run.body.status === "completed" || run.body.status === "failed";
    });

    const content = await fetchApi(`/api/uploads/${uploadId}/content`, {
      cookies: owner.cookies,
    });
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(image);
  });
});
