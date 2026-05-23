import { afterEach, describe, expect, test } from "bun:test";
import type { ArtifactDescriptor } from "../../artifacts/repo";
import { env } from "../../env";
import {
  ARTIFACT_TOOLS,
  executeArtifactTool,
  setSandboxArtifactPublisherForTest,
} from "./artifact-tools";

afterEach(() => setSandboxArtifactPublisherForTest(null));

describe("artifact gateway contract", () => {
  test("supports editable companions and explicit screenshot-proof publication", () => {
    const publish = ARTIFACT_TOOLS.find((tool) => tool.name === "artifact_publish");
    expect(publish?.inputSchema.required).toEqual(["path"]);
    expect(publish?.inputSchema.properties.editable_path).toEqual({
      type: "string",
      description:
        "Optional sandbox path to an editable companion so the file previews and edits in " +
        "Skynet: HTML for a DOCX, CSV for an XLSX, or a v2 deck JSON (theme + positioned blocks, " +
        "the full visual design) for a PPTX. Without it, " +
        "an Office file is download-only.",
    });
    expect(publish?.inputSchema.properties.purpose).toEqual({
      type: "string",
      enum: ["user_requested_proof", "deliverable"],
      description:
        "Required as user_requested_proof when publishing a private desktop inspection screenshot. Use deliverable or omit it for normal files the user requested.",
    });
    expect(publish?.description).toContain("Office bytes remain immutable");
    expect(publish?.description).toContain("purpose=user_requested_proof");
    expect(publish?.description).toContain("download-only");
  });

  test("rejects private inspection screenshots before sandbox publication unless proof is explicit", async () => {
    const rejected = await executeArtifactTool(
      {
        orgId: "org-1",
        userId: "user-1",
        threadId: "thread-1",
        runId: "run-1",
        scope: "run",
        exp: Date.now() + 60_000,
      },
      "artifact_publish",
      { path: "/root/work/screenshots/screenshot-1786558088313.png" },
    );

    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]?.text).toContain("Private desktop inspection screenshots");

    const daytonaRejected = await executeArtifactTool(
      {
        orgId: "org-1",
        userId: "user-1",
        threadId: "thread-1",
        runId: "run-1",
        scope: "run",
        exp: Date.now() + 60_000,
      },
      "artifact_publish",
      { path: "/home/daytona/work/screenshots/screenshot-1786558088313.png" },
    );

    expect(daytonaRejected.isError).toBe(true);
  });

  test("reports absolute FRONTEND_ORIGIN artifact URLs the model must use verbatim", async () => {
    const artifact: ArtifactDescriptor = {
      id: "artifact-1",
      run_id: "run-1",
      thread_id: "thread-1",
      name: "report.pdf",
      source_path: "/root/work/report.pdf",
      content_type: "application/pdf",
      size_bytes: 1234,
      sha256: "abc",
      created_at: "2026-08-17T00:00:00.000Z",
      preview_url: "/api/artifacts/artifact-1/content",
      download_url: "/api/artifacts/artifact-1/content?download=1",
      workpiece: null,
    };
    setSandboxArtifactPublisherForTest(async () => ({ artifact, created: true }));

    const published = await executeArtifactTool(
      {
        orgId: "org-1",
        userId: "user-1",
        threadId: "thread-1",
        runId: "run-1",
        scope: "run",
        exp: Date.now() + 60_000,
      },
      "artifact_publish",
      { path: "/root/work/report.pdf" },
    );

    expect(published.isError).toBeUndefined();
    const text = published.content[0]?.text ?? "";
    expect(env.FRONTEND_ORIGIN).toMatch(/^https?:\/\//);
    expect(text).toContain("as artifact artifact-1");
    expect(text).toContain(
      `Preview URL (use exactly as written, never substitute another host): ${env.FRONTEND_ORIGIN}/api/artifacts/artifact-1/content`,
    );
    expect(text).toContain(
      `Download URL (use exactly as written): ${env.FRONTEND_ORIGIN}/api/artifacts/artifact-1/content?download=1`,
    );
    expect(published.structuredContent).toMatchObject({
      artifact: { id: "artifact-1", preview_url: "/api/artifacts/artifact-1/content" },
      preview_url_absolute: `${env.FRONTEND_ORIGIN}/api/artifacts/artifact-1/content`,
      download_url_absolute: `${env.FRONTEND_ORIGIN}/api/artifacts/artifact-1/content?download=1`,
    });
  });
});
