import { publishSandboxArtifact } from "../../artifacts/publish";
import { proposeWorkpieceEdit } from "../../artifacts/proposals";
import type { ArtifactDescriptor } from "../../artifacts/repo";
import { publishOrgChange } from "../../runs/org-signals";
import { absoluteArtifactUrl, absoluteArtifactUrlContent } from "./artifact-links";
import type { ToolTokenClaims } from "./token";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const result = (text: string, structuredContent?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
});

const failure = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

const INSPECTION_SCREENSHOT_PATH =
  /^(?:\/root|\/home\/daytona)\/work\/screenshots\/screenshot-\d+\.png$/;

function requiresUserProofPurpose(path: string): boolean {
  return INSPECTION_SCREENSHOT_PATH.test(path);
}

export const ARTIFACT_TOOLS = [
  {
    name: "artifact_publish",
    description:
      "Publish a file from your sandbox as a durable Skynet artifact. The trusted " +
      "backend pulls and size-checks the bytes once, records an immutable digest, " +
      "and returns browser preview/download references. Text and CSV files open directly " +
      "in Skynet's editor, and PDFs preview inline. To make a document, spreadsheet, or " +
      "deck editable and previewable instead of download-only, publish the native file AND " +
      "pass editable_path to a companion produced in the same sandbox (HTML for a DOCX, CSV " +
      "for an XLSX, and for a PPTX a deck JSON {deck:{schemaVersion:2,theme,slides:[{id,blocks}]}} " +
      "carrying the VISUAL DESIGN: theme colors, backgrounds, positioned heading/text/image " +
      "blocks - publish artwork as separate image artifacts and reference their absolute URLs " +
      "in image blocks). PREFER authoring decks as deck JSON over scripting PPTX binaries: the " +
      "workspace renders the design natively and Export produces the designed PPTX for you. " +
      "The Office bytes remain immutable. " +
      "Publishing a raw .docx, .xlsx, or .pptx with no companion yields a download-only card " +
      "with no preview or editor, so prefer the companion for deliverables the user will read " +
      "or edit. Use this for screenshots, reports, documents, spreadsheets, videos, " +
      "and other outputs the user needs. Private desktop inspection screenshots produced " +
      "by computer_screenshot or computer_sequence require purpose=user_requested_proof; " +
      "do not publish intermediate inspection screenshots.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the completed file inside your sandbox.",
        },
        name: {
          type: "string",
          description: "Optional download filename. Defaults to the sandbox basename.",
        },
        editable_path: {
          type: "string",
          description:
            "Optional sandbox path to an editable companion so the file previews and edits in " +
            "Skynet: HTML for a DOCX, CSV for an XLSX, or a v2 deck JSON (theme + positioned blocks, " +
            "the full visual design) for a PPTX. Without it, " +
            "an Office file is download-only.",
        },
        purpose: {
          type: "string",
          enum: ["user_requested_proof", "deliverable"],
          description:
            "Required as user_requested_proof when publishing a private desktop inspection screenshot. Use deliverable or omit it for normal files the user requested.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "workpiece_propose_edit",
    description:
      "Propose an edit to an existing editable workpiece (a document, spreadsheet, " +
      "presentation, or PDF text companion you previously published with artifact_publish). " +
      "The edit is recorded as a PROPOSED revision for the user to review: it does NOT change " +
      "what the user currently sees until they accept it. Pass the artifact id returned by " +
      "artifact_publish and the FULL replacement state for the workpiece's kind - document: a themed rich document " +
      '{"document": {"schemaVersion": 2, "theme": {"background": {"type": "color", "color": "#101020"}, "heading": "#f5f5ff", ' +
      '"body": "#c8c8e0", "accent": "#ff8844"}, "html": "<h1>...</h1><p>...</p>"}} carrying the theme colors + rich-HTML body ' +
      '(or, more simply, {"html": string} which is upgraded to a default-themed document, or {"text": string} for a plain-text source doc); spreadsheet: a workbook ' +
      '{"workbook": {"schemaVersion": 2, "activeSheetId": "sheet-1", "sheets": [{"id","name","rowCount","colCount",' +
      '"cells": {"A1": {"v": string|number, "f"?: "=SUM(A2:A9)", "fmt"?: {"bold"?, "numFmt"?: "currency"|"percent"|"0"|"0.00"}}}}]}} ' +
      'or, more simply, {"csv": string} which is upgraded to a single-sheet workbook automatically; presentation: a deck ' +
      '{"deck": {"schemaVersion": 2, "theme": {...}, "slides": [{"id","blocks":[{id,type,x,y,w,h,content}]}]}} ' +
      'or, more simply, {"slides": [{"title": string, "body": string, "notes"?: string}]} which is ' +
      'upgraded to a deck automatically; pdf: {"pdfText": string}. ' +
      "Optionally include a short summary of what changed. Use this to revise a deliverable after " +
      "feedback instead of publishing a brand-new file; mainline is untouched until the user accepts.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_id: {
          type: "string",
          description: "The workpiece artifact id returned by artifact_publish.",
        },
        state: {
          type: "object",
          description:
            "Full replacement workpiece state for the artifact's kind: document {document:{schemaVersion,theme,html}} " +
            "(or {html} upgraded to a default-themed document, or {text} for a plain-text source doc), " +
            "spreadsheet {workbook:{schemaVersion,activeSheetId,sheets:[{id,name,rowCount,colCount,cells}]}} " +
            "(or {csv} which is upgraded to a single-sheet workbook), presentation " +
            "{deck:{schemaVersion,theme,slides}} (or {slides:[{title,body,notes?}]} which is upgraded to a deck), " +
            "or pdf {pdfText}.",
        },
        summary: {
          type: "string",
          description:
            "Optional one-line description of the proposed change, shown to the user in the review banner.",
        },
      },
      required: ["artifact_id", "state"],
      additionalProperties: false,
    },
  },
] as const;

export const ARTIFACT_TOOL_NAMES: ReadonlySet<string> = new Set(
  ARTIFACT_TOOLS.map((tool) => tool.name),
);

type SandboxArtifactPublisher = (
  input: Parameters<typeof publishSandboxArtifact>[0],
) => Promise<{ artifact: ArtifactDescriptor; created: boolean }>;

let publisherOverride: SandboxArtifactPublisher | null = null;

/** Test-only seam: production always publishes through the artifacts pipeline. */
export function setSandboxArtifactPublisherForTest(
  publisher: SandboxArtifactPublisher | null,
): void {
  publisherOverride = publisher;
}

export async function executeArtifactTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (name === "workpiece_propose_edit") return proposeWorkpieceEditTool(claims, args);
  if (name !== "artifact_publish") return failure(`Unknown tool: ${name}`);
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) return failure("artifact_publish requires a `path` inside the sandbox.");
  if (requiresUserProofPurpose(path) && args.purpose !== "user_requested_proof") {
    return failure(
      "Private desktop inspection screenshots can only be published when the user explicitly requested durable proof. Retry artifact_publish with purpose=user_requested_proof for the final requested screenshot only.",
    );
  }
  try {
    const published = await (publisherOverride ?? publishSandboxArtifact)({
      orgId: claims.orgId,
      userId: claims.userId,
      runId: claims.runId,
      threadId: claims.threadId,
      path,
      ...(typeof args.name === "string" && args.name.trim() ? { name: args.name.trim() } : {}),
      ...(typeof args.editable_path === "string" && args.editable_path.trim()
        ? { editablePath: args.editable_path.trim() }
        : {}),
    });
    return result(
      `${published.created ? "Published" : "Already published"} ${published.artifact.name} ` +
        `(${published.artifact.size_bytes} bytes) as artifact ${published.artifact.id}.\n` +
        "Preview URL (use exactly as written, never substitute another host): " +
        `${absoluteArtifactUrl(published.artifact.preview_url)}\n` +
        `Download URL (use exactly as written): ${absoluteArtifactUrl(published.artifact.download_url)}`,
      {
        artifact: published.artifact,
        created: published.created,
        ...absoluteArtifactUrlContent(published.artifact),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "artifact publish failed";
    return failure(`Could not publish ${path}: ${message}`);
  }
}

const WORKPIECE_STATE_SHAPES: Readonly<Record<string, string>> = {
  document:
    '{"document": {"schemaVersion": 2, "theme": {...}, "html": string}} (or {"html": string} / {"text": string})',
  spreadsheet:
    '{"workbook": {"schemaVersion": 2, "activeSheetId", "sheets": [{"id", "name", "rowCount", "colCount", "cells"}]}} or {"csv": string}',
  presentation:
    '{"deck": {"schemaVersion": 2, "theme": {...}, "slides": [...]}} or {"slides": [{"title", "body", "notes"?}]}',
  pdf: '{"pdfText": string}',
};

async function proposeWorkpieceEditTool(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const artifactId = typeof args.artifact_id === "string" ? args.artifact_id.trim() : "";
  if (!artifactId) {
    return failure("workpiece_propose_edit requires an `artifact_id` from artifact_publish.");
  }
  if (!args.state || typeof args.state !== "object" || Array.isArray(args.state)) {
    return failure(
      "workpiece_propose_edit requires a `state` object matching the workpiece kind.",
    );
  }
  const summary =
    typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : null;
  try {
    const proposed = await proposeWorkpieceEdit({
      orgId: claims.orgId,
      artifactId,
      proposerRunId: claims.runId,
      state: args.state,
      summary,
    });
    if (proposed.outcome === "not_found") {
      return failure(
        `No editable workpiece found for artifact ${artifactId} in this workspace. Publish an ` +
          "editable file with artifact_publish first, then propose edits against its id.",
      );
    }
    if (proposed.outcome === "invalid_state") {
      return failure(
        `The proposed state is not a valid ${proposed.kind} workpiece. Send the full state as ` +
          `${WORKPIECE_STATE_SHAPES[proposed.kind] ?? "the kind's documented shape"}.`,
      );
    }
    publishOrgChange(claims.orgId, {
      type: "artifact",
      action: "proposed",
      artifactId: proposed.artifact.id,
      runId: proposed.artifact.runId,
      threadId: proposed.artifact.threadId,
    });
    return result(
      `Proposed changes to ${proposed.artifact.name} (workpiece ${proposed.artifact.id}). ` +
        "The user will review and accept or dismiss them; the workpiece keeps showing the current " +
        "version until they accept. No further action is needed from you.",
      {
        proposal_id: proposed.proposal.id,
        artifact_id: proposed.artifact.id,
        status: "pending",
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "workpiece proposal failed";
    return failure(`Could not propose changes to ${artifactId}: ${message}`);
  }
}
