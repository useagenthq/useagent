import { afterEach, describe, expect, test } from "bun:test";
import { isArtifactWorkpieceState, PRESENTATION_SCHEMA_VERSION } from "@useagent/artifact-workspace";
import type { ArtifactDescriptor } from "../../artifacts/repo";
import { env } from "../../env";
import {
  ARTIFACT_TOOLS,
  executeArtifactTool,
  setSandboxArtifactPublisherForTest,
} from "./artifact-tools";

type JsonSchemaLike = {
  readonly anyOf?: readonly JsonSchemaLike[];
  readonly properties?: Readonly<Record<string, JsonSchemaLike>>;
  readonly items?: JsonSchemaLike;
  readonly required?: readonly string[];
  readonly pattern?: string;
  readonly [key: string]: unknown;
};

function hasSchemaProperty(
  schema: JsonSchemaLike,
  key: string,
): schema is JsonSchemaLike & { readonly properties: Readonly<Record<string, JsonSchemaLike>> } {
  return schema.properties?.[key] !== undefined;
}

afterEach(() => setSandboxArtifactPublisherForTest(null));

describe("artifact gateway contract", () => {
  test("supports editable companions and explicit screenshot-proof publication", () => {
    const publish = ARTIFACT_TOOLS.find((tool) => tool.name === "artifact_publish");
    expect(publish?.inputSchema.required).toEqual(["path"]);
    expect(publish?.inputSchema.properties.editable_path).toEqual({
      type: "string",
      description:
        "Optional sandbox path to an editable companion so the file previews and edits in " +
        "useAgent: HTML for a DOCX, CSV for an XLSX, or a v2 deck JSON (theme + positioned blocks, " +
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
    // Guidance is flipped: deliverables are steered to native authoring.
    expect(publish?.description).toContain("call workpiece_create");
  });

  test("exposes workpiece_create for one-call native authoring", () => {
    const create = ARTIFACT_TOOLS.find((tool) => tool.name === "workpiece_create");
    expect(create?.inputSchema.required).toEqual(["kind", "name", "state"]);
    expect(create?.inputSchema.additionalProperties).toBe(false);
    expect(create?.inputSchema.properties.kind).toMatchObject({
      type: "string",
      enum: ["document", "spreadsheet", "presentation", "pdf-text"],
    });
    expect(create?.description).toContain("renders it natively");
    expect(create?.description).toContain("no file");
  });

  test("exposes direct requested edits without adding an approval capability", () => {
    const update = ARTIFACT_TOOLS.find((tool) => tool.name === "workpiece_update");

    expect(update?.inputSchema.required).toEqual(["artifact_id", "state"]);
    expect(update?.inputSchema.additionalProperties).toBe(false);
    expect(update?.inputSchema.properties).not.toHaveProperty("approvalCapability");
    expect(update?.description).toContain("without a second approval prompt");
    expect(update?.description).toContain("Revision conflicts fail closed");
  });

  test("describes canonical presentation deck state precisely for MCP callers", () => {
    const create = ARTIFACT_TOOLS.find((tool) => tool.name === "workpiece_create");
    const propose = ARTIFACT_TOOLS.find((tool) => tool.name === "workpiece_propose_edit");
    const update = ARTIFACT_TOOLS.find((tool) => tool.name === "workpiece_update");
    const createState = create?.inputSchema.properties.state as JsonSchemaLike | undefined;
    const proposeState = propose?.inputSchema.properties.state as JsonSchemaLike | undefined;
    const updateState = update?.inputSchema.properties.state as JsonSchemaLike | undefined;
    expect(proposeState).toEqual(createState);
    expect(updateState).toEqual(createState);

    const stateBranches = createState?.anyOf ?? [];
    const presentationState = stateBranches.find((branch) => hasSchemaProperty(branch, "deck"));
    expect(presentationState).toMatchObject({
      type: "object",
      required: ["deck"],
      additionalProperties: false,
    });
    expect(stateBranches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: ["document"] }),
        expect.objectContaining({ required: ["html"] }),
        expect.objectContaining({ required: ["text"] }),
        expect.objectContaining({ required: ["workbook"] }),
        expect.objectContaining({ required: ["csv"] }),
        expect.objectContaining({ required: ["pdfText"] }),
      ]),
    );

    const deck = presentationState!.properties.deck!;
    const theme = deck.properties!.theme!;
    const slide = deck.properties!.slides!.items!;
    const block = slide.properties!.blocks!.items!;
    expect(deck).toMatchObject({
      type: "object",
      required: ["schemaVersion", "theme", "slides"],
      additionalProperties: false,
      properties: { schemaVersion: { type: "number", enum: [2] } },
    });
    expect(theme.properties!.background!.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "string", pattern: expect.stringContaining("#") }),
        expect.objectContaining({ required: ["type", "color"] }),
        expect.objectContaining({ required: ["type", "from", "to"] }),
        expect.objectContaining({ required: ["type", "url"] }),
      ]),
    );
    expect(theme.properties!.heading!.pattern).toContain("#");
    expect(theme.required).toEqual(["background", "heading", "body", "accent"]);
    expect(slide.required).toEqual(["id", "blocks"]);
    expect(block).toMatchObject({
      required: ["id", "type", "x", "y", "w", "h", "content"],
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["heading", "text", "image", "shape"] },
        content: { type: "string" },
        x: { type: "number", minimum: 0, maximum: 100 },
        y: { type: "number", minimum: 0, maximum: 100 },
        w: { type: "number", minimum: 0, maximum: 100 },
        h: { type: "number", minimum: 0, maximum: 100 },
      },
    });
    const workbookState = stateBranches.find((branch) => hasSchemaProperty(branch, "workbook"));
    const cells = workbookState!.properties.workbook!.properties!.sheets!.items!.properties!.cells!;
    const cell = cells.additionalProperties as JsonSchemaLike;
    expect(cell.anyOf).toEqual([
      { required: ["v"] },
      { required: ["f"] },
    ]);
    expect(block.properties!.content).not.toHaveProperty("properties");
    expect(block.properties!.style).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        color: expect.objectContaining({ type: "string" }),
        fontSize: expect.objectContaining({ type: "number" }),
        align: { type: "string", enum: ["left", "center", "right"] },
      },
    });
  });

  test("accepts the advertised canonical presentation deck state and rejects malformed deck shapes", () => {
    const validState = {
      deck: {
        schemaVersion: PRESENTATION_SCHEMA_VERSION,
        theme: {
          background: { type: "gradient", from: "#101828", to: "#344054", angle: 145 },
          heading: "#ffffff",
          body: "#d0d5dd",
          accent: "#ffcc66",
        },
        slides: [{
          id: "slide-1",
          blocks: [
            {
              id: "title",
              type: "heading",
              x: 6,
              y: 8,
              w: 88,
              h: 16,
              content: "Launch narrative",
              style: { fontSize: 84, bold: true, align: "left", color: "#ffffff" },
            },
            {
              id: "body",
              type: "text",
              x: 6,
              y: 30,
              w: 70,
              h: 40,
              content: "Use strings for content and style fields for presentation.",
              style: { fontSize: 40, align: "left" },
            },
          ],
          notes: "Speaker note",
        }],
      },
    } as const;

    expect(isArtifactWorkpieceState("presentation", validState)).toBe(true);
    expect(isArtifactWorkpieceState("presentation", {
      deck: {
        ...validState.deck,
        slides: [{
          ...validState.deck.slides[0],
          blocks: [{ ...validState.deck.slides[0].blocks[0], content: { text: "wrong" } }],
        }],
      },
    })).toBe(false);
    expect(isArtifactWorkpieceState("presentation", {
      deck: {
        ...validState.deck,
        theme: {
          background: "#101828",
          heading: "#ffffff",
          body: "#d0d5dd",
          accent: "#ffcc66",
        },
      },
    })).toBe(true);
    expect(isArtifactWorkpieceState("presentation", {
      deck: {
        ...validState.deck,
        theme: { ...validState.deck.theme, background: "not-a-color" },
      },
    })).toBe(false);
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

  test("rejects protected secret paths before invoking the artifact publisher", async () => {
    let called = false;
    setSandboxArtifactPublisherForTest(async () => {
      called = true;
      throw new Error("publisher must not be called");
    });

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
      { path: "/root/work/../.skynet/secrets/credential.json" },
    );

    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]?.text).toContain("Protected secret paths");
    expect(called).toBe(false);
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
      preview_pdf_url: null,
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
