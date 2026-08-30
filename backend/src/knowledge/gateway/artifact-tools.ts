import type { ArtifactWorkpieceKind } from "@useagent/artifact-workspace";
import { ArtifactAuthoringError, createAuthoredArtifact } from "../../artifacts/authoring";
import { publishArtifactChangeFromTool } from "../../artifacts/change-bridge";
import { publishSandboxArtifact } from "../../artifacts/publish";
import { acceptWorkpieceProposal, proposeWorkpieceEdit } from "../../artifacts/proposals";
import { toArtifactDescriptor, type ArtifactDescriptor } from "../../artifacts/repo";
import { isProtectedInjectedSecretPath } from "../../secrets/inject";
import {
  absoluteArtifactPreviewUrl,
  absoluteArtifactUrl,
  absoluteArtifactUrlContent,
} from "./artifact-links";
import type { ToolTokenClaims } from "./token";
import { WORKPIECE_STATE_INPUT_SCHEMA } from "./workpiece-state-schema";

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
      "Publish a file from your sandbox as a durable useAgent artifact. The trusted " +
      "backend pulls and size-checks the bytes once, records an immutable digest, " +
      "and returns browser preview/download references. Use this for FILES the user " +
      "explicitly wants AS files - screenshots, exported reports, videos, archives, and " +
      "other raw outputs. Text and CSV files open directly in useAgent's editor, and PDFs " +
      "preview inline. " +
      "To make a DOCUMENT, SPREADSHEET, or DECK the user will read or edit, do NOT script an " +
      "Office binary: call workpiece_create with the canonical state (for a deck, deck JSON " +
      "{deck:{schemaVersion:2,theme,slides:[{id,blocks}]}} carrying the VISUAL DESIGN - theme " +
      "colors, backgrounds, positioned heading/text/image blocks, with artwork published as " +
      "separate image artifacts referenced by absolute URL in image blocks). The workspace " +
      "renders it natively, it opens in the user's workspace, and Export produces the Office " +
      "file for them. " +
      "If you already have a native Office file on disk, you may still pass editable_path to a " +
      "companion produced in the same sandbox (HTML for a DOCX, CSV for an XLSX, deck JSON for a " +
      "PPTX) so it previews and edits. The Office bytes remain immutable. " +
      "Publishing a raw .docx, .xlsx, or .pptx with no companion yields a download-only card " +
      "with no editor (a PDF preview is attached when it can be rendered). When you REGENERATE a " +
      "file you already published (a new version of the same deliverable), pass " +
      "updates_artifact_id with that artifact's id: the new bytes + companion land as a NEW " +
      "REVISION of the same artifact (one tab, with history) instead of a second card. " +
      "Private desktop inspection screenshots produced " +
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
            "useAgent: HTML for a DOCX, CSV for an XLSX, or a v2 deck JSON (theme + positioned blocks, " +
            "the full visual design) for a PPTX. Without it, " +
            "an Office file is download-only.",
        },
        updates_artifact_id: {
          type: "string",
          description:
            "Optional id of an artifact you previously published that this file is a regenerated " +
            "version of. When set, the new bytes + companion replace that artifact as a new revision " +
            "(same tab, with history) instead of creating a second artifact. The kind must match " +
            "(a docx updates a document, an xlsx a spreadsheet, and so on).",
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
    name: "workpiece_update",
    description:
      "Apply the user's explicitly requested edit directly to an existing editable document, " +
      "spreadsheet, presentation, or PDF text workpiece. Pass the artifact id and the FULL " +
      "replacement state. This advances the existing workpiece as a new revision immediately, " +
      "without a second approval prompt, because the user's message already authorized the edit. " +
      "Revision conflicts fail closed instead of overwriting concurrent user changes. Use " +
      "workpiece_propose_edit instead for unsolicited suggestions that the user did not request.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_id: {
          type: "string",
          description: "The existing editable workpiece artifact id.",
        },
        state: {
          ...WORKPIECE_STATE_INPUT_SCHEMA,
        },
        summary: {
          type: "string",
          description: "Optional one-line description of the applied change.",
        },
      },
      required: ["artifact_id", "state"],
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
          ...WORKPIECE_STATE_INPUT_SCHEMA,
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
  {
    name: "workpiece_create",
    description:
      "Create an editable, previewable workpiece natively from its canonical state - no file, no " +
      "editable_path, no scripting an Office binary. This is the EASIEST and preferred way to " +
      "produce a document, spreadsheet, or deck the user will read or edit: pass the kind, a name, " +
      "and the canonical v2 state, and useAgent creates the artifact, renders it natively, and opens " +
      "it in the user's workspace. Export then produces the Office file (DOCX/XLSX/PPTX/PDF). " +
      "State by kind: document a themed rich document " +
      "{document:{schemaVersion:2,theme:{background,heading,body,accent},html}} (or {html} / {text}); " +
      "spreadsheet a workbook {workbook:{schemaVersion:2,activeSheetId,sheets:[{id,name,rowCount,colCount,cells}]}} " +
      "(or {csv}); presentation a deck {deck:{schemaVersion:2,theme,slides:[{id,blocks:[{id,type,x,y,w,h,content}]}]}} " +
      "(or {slides:[{title,body,notes?}]}) - publish artwork as separate image artifacts and reference their " +
      "absolute URLs in image blocks; pdf-text a text-authored PDF {pdfText:string}.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["document", "spreadsheet", "presentation", "pdf-text"],
          description: "The workpiece kind to author.",
        },
        name: {
          type: "string",
          description:
            'The workpiece file name, e.g. "Q3 plan.docx". An extension matching the kind is added if you omit one.',
        },
        state: {
          ...WORKPIECE_STATE_INPUT_SCHEMA,
        },
        summary: {
          type: "string",
          description: "Optional one-line note about what you created, shown in the run timeline.",
        },
      },
      required: ["kind", "name", "state"],
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
  if (name === "workpiece_update") return updateWorkpieceTool(claims, args);
  if (name === "workpiece_create") return workpieceCreateTool(claims, args);
  if (name !== "artifact_publish") return failure(`Unknown tool: ${name}`);
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) return failure("artifact_publish requires a `path` inside the sandbox.");
  const editablePath = typeof args.editable_path === "string" ? args.editable_path.trim() : "";
  if (
    isProtectedInjectedSecretPath(path) ||
    (editablePath && isProtectedInjectedSecretPath(editablePath))
  ) {
    return failure("Protected secret paths and dotenv files cannot be published as artifacts.");
  }
  if (requiresUserProofPurpose(path) && args.purpose !== "user_requested_proof") {
    return failure(
      "Private desktop inspection screenshots can only be published when the user explicitly requested durable proof. Retry artifact_publish with purpose=user_requested_proof for the final requested screenshot only.",
    );
  }
  const updatesArtifactId =
    typeof args.updates_artifact_id === "string" && args.updates_artifact_id.trim()
      ? args.updates_artifact_id.trim()
      : undefined;
  try {
    const published = await (publisherOverride ?? publishSandboxArtifact)({
      orgId: claims.orgId,
      userId: claims.userId,
      runId: claims.runId,
      threadId: claims.threadId,
      path,
      ...(typeof args.name === "string" && args.name.trim() ? { name: args.name.trim() } : {}),
      ...(editablePath ? { editablePath } : {}),
      ...(updatesArtifactId ? { updatesArtifactId } : {}),
    });
    const verb = updatesArtifactId ? "Revised" : published.created ? "Published" : "Already published";
    return result(
      `${verb} ${published.artifact.name} ` +
        `(${published.artifact.size_bytes} bytes) as artifact ${published.artifact.id}.\n` +
        "Preview URL (use exactly as written, never substitute another host): " +
        `${absoluteArtifactPreviewUrl(published.artifact)}\n` +
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
  const staged = await stageWorkpieceEdit(claims, args);
  if (!staged.ok) return staged.result;
  const { proposed } = staged;
  await publishArtifactChangeFromTool(claims, proposed.artifact, "proposed");
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
}

type StagedWorkpieceEdit = Extract<
  Awaited<ReturnType<typeof proposeWorkpieceEdit>>,
  { readonly outcome: "proposed" }
>;

async function stageWorkpieceEdit(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<{ readonly ok: true; readonly proposed: StagedWorkpieceEdit } | {
  readonly ok: false;
  readonly result: ToolResult;
}> {
  const artifactId = typeof args.artifact_id === "string" ? args.artifact_id.trim() : "";
  if (!artifactId) {
    return { ok: false, result: failure("workpiece edit requires an existing `artifact_id`.") };
  }
  if (!args.state || typeof args.state !== "object" || Array.isArray(args.state)) {
    return {
      ok: false,
      result: failure("workpiece edit requires a `state` object matching the workpiece kind."),
    };
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
      return {
        ok: false,
        result: failure(
          `No editable workpiece found for artifact ${artifactId} in this workspace. Publish or ` +
            "create an editable workpiece first, then edit its id.",
        ),
      };
    }
    if (proposed.outcome === "invalid_state") {
      return {
        ok: false,
        result: failure(
          `The replacement state is not a valid ${proposed.kind} workpiece. Send the full state as ` +
            `${WORKPIECE_STATE_SHAPES[proposed.kind] ?? "the kind's documented shape"}.`,
        ),
      };
    }
    return { ok: true, proposed };
  } catch (error) {
    const message = error instanceof Error ? error.message : "workpiece edit failed";
    return { ok: false, result: failure(`Could not edit ${artifactId}: ${message}`) };
  }
}

async function updateWorkpieceTool(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const staged = await stageWorkpieceEdit(claims, args);
  if (!staged.ok) return staged.result;
  const { proposed } = staged;
  try {
    const accepted = await acceptWorkpieceProposal({
      orgId: claims.orgId,
      artifactId: proposed.artifact.id,
      proposalId: proposed.proposal.id,
      resolvedBy: null,
    });
    if (accepted.outcome === "revision_conflict") {
      return failure(
        "The workpiece changed while this edit was being applied. Read the current state and retry " +
          "the requested edit against that revision; no user change was overwritten.",
      );
    }
    if (accepted.outcome !== "accepted") {
      return failure(`The direct workpiece edit could not be applied (${accepted.outcome}).`);
    }
    const artifact = toArtifactDescriptor(accepted.artifact);
    await publishArtifactChangeFromTool(claims, accepted.artifact, "updated");
    return result(
      `Applied the requested edit to ${accepted.artifact.name} as workpiece revision ` +
        `${accepted.artifact.workpieceRevision}. The prior revision was not overwritten and no ` +
        "additional approval is required.",
      {
        proposal_id: proposed.proposal.id,
        artifact_id: accepted.artifact.id,
        status: "applied",
        state_revision: accepted.artifact.workpieceRevision,
        artifact,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "workpiece update failed";
    return failure(`Could not apply the requested edit: ${message}`);
  }
}

/** Map the tool's authoring kind onto the canonical workpiece kind. `pdf-text`
 * names the only natively-authorable PDF (text rendered to a fresh PDF). */
function workpieceCreateKind(value: unknown): ArtifactWorkpieceKind | null {
  if (value === "document" || value === "spreadsheet" || value === "presentation") return value;
  if (value === "pdf-text" || value === "pdf") return "pdf";
  return null;
}

async function workpieceCreateTool(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const kind = workpieceCreateKind(args.kind);
  if (!kind) {
    return failure("workpiece_create requires kind = document, spreadsheet, presentation, or pdf-text.");
  }
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "";
  if (!name) return failure("workpiece_create requires a `name` for the workpiece.");
  if (!args.state || typeof args.state !== "object" || Array.isArray(args.state)) {
    return failure(
      `workpiece_create requires a \`state\` object matching the kind (${
        WORKPIECE_STATE_SHAPES[kind] ?? "the kind's documented shape"
      }).`,
    );
  }
  try {
    const created = await createAuthoredArtifact({
      orgId: claims.orgId,
      userId: claims.userId,
      runId: claims.runId,
      threadId: claims.threadId,
      kind,
      name,
      state: args.state,
    });
    const note = typeof args.summary === "string" && args.summary.trim()
      ? ` ${args.summary.trim()}`
      : "";
    return result(
      `Created ${created.artifact.name} as artifact ${created.artifact.id}. It renders natively and ` +
        `is now open in the user's workspace; Export produces the Office file.${note}\n` +
        "Preview URL (use exactly as written, never substitute another host): " +
        `${absoluteArtifactPreviewUrl(created.artifact)}\n` +
        `Download URL (use exactly as written): ${absoluteArtifactUrl(created.artifact.download_url)}`,
      {
        artifact: created.artifact,
        created: created.created,
        ...absoluteArtifactUrlContent(created.artifact),
      },
    );
  } catch (error) {
    if (error instanceof ArtifactAuthoringError) {
      return failure(
        `Could not create ${name}: ${error.message}. Send the full ${kind} state as ${
          WORKPIECE_STATE_SHAPES[kind] ?? "the kind's documented shape"
        }.`,
      );
    }
    const message = error instanceof Error ? error.message : "workpiece create failed";
    return failure(`Could not create ${name}: ${message}`);
  }
}
