import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setArtifactStorageForTest } from "../src/artifacts/storage";
import { db } from "../src/db/client";
import { userUploads } from "../src/db/schema";
import { createOrgSession, fetchApi, json, type OrgSession, waitFor } from "./helpers";
import { InMemoryArtifactStorage } from "./in-memory-artifact-storage";

const storage = new InMemoryArtifactStorage();
const source = new TextEncoder().encode("quarter,revenue\nQ1,42\n");
let owner: OrgSession;
let outsider: OrgSession;

async function postUpload(session: OrgSession): Promise<{
  id: string;
  name: string;
  download_url: string;
}> {
  const form = new FormData();
  form.set("file", new File([source], "quarterly.csv", { type: "text/plain" }));
  const response = await fetchApi("/api/uploads", {
    method: "POST",
    cookies: session.cookies,
    body: form,
  });
  expect(response.status).toBe(201);
  const payload = (await response.json()) as {
    upload: { id: string; name: string; download_url: string };
  };
  return payload.upload;
}

beforeAll(async () => {
  owner = await createOrgSession("upload-owner");
  outsider = await createOrgSession("upload-outsider");
  setArtifactStorageForTest(storage);
});

afterAll(() => {
  setArtifactStorageForTest(null);
});

describe("user upload API", () => {
  test("uploads exact bytes, isolates download, and atomically attaches once", async () => {
    const upload = await postUpload(owner);
    expect(upload.name).toBe("quarterly.csv");
    expect(upload.download_url).toBe(`/api/uploads/${upload.id}/content`);

    const content = await fetchApi(upload.download_url, { cookies: owner.cookies });
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(content.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(source);

    const outside = await fetchApi(upload.download_url, { cookies: outsider.cookies });
    expect(outside.status).toBe(404);

    const accepted = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: owner.cookies,
      body: { prompt: "summarize the attachment", attachments: [upload.id] },
    });
    expect(accepted.status).toBe(201);
    const [claimed] = await db
      .select({ runId: userUploads.runId })
      .from(userUploads)
      .where(eq(userUploads.id, upload.id));
    expect(claimed?.runId).toBe(accepted.body.id);

    await waitFor(async () => {
      const run = await json<{ status: string }>(`/api/runs/${accepted.body.id}`, {
        cookies: owner.cookies,
      });
      return run.body.status === "completed";
    });

    const reused = await json<{ error: string }>("/api/runs", {
      method: "POST",
      cookies: owner.cookies,
      body: { prompt: "reuse it", attachments: [upload.id] },
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("upload_unavailable");

    const removed = await fetchApi(`/api/uploads/${upload.id}`, {
      method: "DELETE",
      cookies: owner.cookies,
    });
    expect(removed.status).toBe(404);
  });

  test("rejects an upload owned by another tenant without creating a run", async () => {
    const upload = await postUpload(owner);
    const rejected = await json<{ error: string }>("/api/runs", {
      method: "POST",
      cookies: outsider.cookies,
      body: { prompt: "steal attachment", attachments: [upload.id] },
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe("upload_unavailable");
  });

  test("hides an expired unclaimed upload from its owner", async () => {
    const upload = await postUpload(owner);
    await db
      .update(userUploads)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(userUploads.id, upload.id));

    const content = await fetchApi(upload.download_url, { cookies: owner.cookies });
    expect(content.status).toBe(404);
  });
});
