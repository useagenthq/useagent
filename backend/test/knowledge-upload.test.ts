import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createOrgSession, fetchApi, type OrgSession } from "./helpers";
import {
  DocumentExtractionError,
  extractDocumentText,
  KNOWLEDGE_UPLOAD_MAX_BYTES,
  knowledgeUploadExtension,
} from "../src/knowledge/extract-text";

const FIXTURE_PDF = new URL("./fixtures/knowledge-sample.pdf", import.meta.url);

async function fixturePdf(): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(FIXTURE_PDF).arrayBuffer());
}

describe("knowledge document text extraction", () => {
  test("markdown and text come through as-is, minus BOM, CRLF and trailing blank runs", async () => {
    const md = await extractDocumentText(
      "runbook.md",
      new TextEncoder().encode("﻿# Deploys\r\n\r\n\r\n\r\nUse the deploy script.   \r\n"),
    );
    expect(md).toEqual({ text: "# Deploys\n\nUse the deploy script.", pages: null });
    const txt = await extractDocumentText("notes.TXT", new TextEncoder().encode("plain notes\n"));
    expect(txt).toEqual({ text: "plain notes", pages: null });
  });

  test("a PDF yields its embedded text across every page", async () => {
    const pdf = await extractDocumentText("warranty.pdf", await fixturePdf());
    expect(pdf.pages).toBe(2);
    expect(pdf.text).toContain("Orbital H-200 heater warranty runs 41 months.");
    expect(pdf.text).toContain("ZK-7731");
    expect(pdf.text).toContain("Second page: escalate to the field team after 30 days.");
  });

  test("unsupported, empty and unreadable files are refused with a coded reason", async () => {
    expect(knowledgeUploadExtension("deck.pptx")).toBeNull();
    expect(knowledgeUploadExtension("a.b.PDF")).toBe("pdf");
    await expect(extractDocumentText("deck.pptx", new Uint8Array([1]))).rejects.toMatchObject({
      code: "unsupported_type",
    });
    await expect(extractDocumentText("blank.md", new TextEncoder().encode("  \n\n"))).rejects.toMatchObject({
      code: "empty_document",
    });
    const broken = extractDocumentText("broken.pdf", new TextEncoder().encode("not a pdf"));
    await expect(broken).rejects.toBeInstanceOf(DocumentExtractionError);
    await expect(broken).rejects.toMatchObject({ code: "unreadable_document" });
  });
});

describe("POST /api/knowledge/upload", () => {
  let session: OrgSession;

  beforeAll(async () => {
    session = await createOrgSession("knowledge-upload");
  });

  // The suite preload strips the distillation key, but a dependency re-reads the
  // operator's own env at app import (pi-utils); strip again so every upload here
  // takes the keyless stub path and never calls a model.
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  async function upload(file: File, folder?: string): Promise<{ status: number; body: any }> {
    const form = new FormData();
    form.set("file", file);
    if (folder) form.set("folder", folder);
    const res = await fetchApi("/api/knowledge/upload", {
      method: "POST",
      body: form,
      cookies: session.cookies,
    });
    return { status: res.status, body: await res.json() };
  }

  test("a markdown file is ingested through the same contract as a pasted note, once", async () => {
    const file = new File(
      ["# Meridian launch\n\nThe Q3 launch checklist lives in the ops wiki and is owned by Sable Fox."],
      "meridian-launch.md",
      { type: "text/markdown" },
    );
    const first = await upload(file, "engineering");
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("stored");
    expect(first.body.file).toEqual({ name: "meridian-launch.md", bytes: file.size, pages: null, chars: expect.any(Number) });
    const listed = await fetchApi("/api/knowledge", { cookies: session.cookies });
    const { records } = (await listed.json()) as { records: Array<{ id: string; domain: string | null; source_type: string | null }> };
    const stored = records.find((record) => record.id === first.body.id);
    expect(stored).toMatchObject({ domain: "engineering", source_type: "document" });

    // Same bytes again: the content hash is the external id, so nothing duplicates.
    const again = await upload(file, "engineering");
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("skipped");
    expect(again.body.id).toBe(first.body.id);
  });

  test("a PDF is stored with its extracted text and page count", async () => {
    const file = new File([await fixturePdf()], "orbital-warranty.pdf", { type: "application/pdf" });
    const result = await upload(file);
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("stored");
    expect(result.body.file.pages).toBe(2);
    const listed = await fetchApi("/api/knowledge", { cookies: session.cookies });
    const { records } = (await listed.json()) as { records: Array<{ id: string; body: string; title: string }> };
    const stored = records.find((record) => record.id === result.body.id);
    expect(`${stored?.title}\n${stored?.body}`).toContain("ZK-7731");
  });

  test("unsupported, empty, missing and oversized files answer with the reason", async () => {
    expect(await upload(new File(["x"], "deck.pptx"))).toMatchObject({
      status: 400,
      body: { error: "unsupported_type" },
    });
    expect(await upload(new File(["\n\n"], "blank.txt"))).toMatchObject({
      status: 422,
      body: { error: "empty_document" },
    });
    const missing = await fetchApi("/api/knowledge/upload", {
      method: "POST",
      body: new FormData(),
      cookies: session.cookies,
    });
    expect(missing.status).toBe(400);
    const huge = new File([new Uint8Array(KNOWLEDGE_UPLOAD_MAX_BYTES + 1)], "huge.txt");
    expect((await upload(huge)).status).toBe(413);
  });

  test("rejects a chunked oversized multipart body before parsing it", async () => {
    const boundary = "useagent-upload-boundary";
    let remaining = KNOWLEDGE_UPLOAD_MAX_BYTES + 128 * 1024;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.txt"\r\n` +
            "Content-Type: text/plain\r\n\r\n",
        ));
      },
      pull(controller) {
        if (remaining <= 0) {
          controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`));
          controller.close();
          return;
        }
        const size = Math.min(256 * 1024, remaining);
        remaining -= size;
        controller.enqueue(new Uint8Array(size));
      },
    });
    const response = await fetchApi("/api/knowledge/upload", {
      method: "POST",
      body: stream,
      cookies: session.cookies,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "file_too_large" });
  });
});
