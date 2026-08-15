import { publishSandboxArtifact } from "../../artifacts/publish";
import type { ToolTokenClaims } from "./token";

interface ToolResult {
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
      "in Skynet's editor. For editable DOCX or XLSX outputs, also provide editable_path " +
      "to a small HTML or CSV companion produced in the sandbox; the Office bytes remain " +
      "immutable. Use this for screenshots, reports, documents, spreadsheets, videos, " +
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
          description: "Optional sandbox path to editable HTML for a DOCX or CSV for an XLSX.",
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
] as const;

export const ARTIFACT_TOOL_NAMES: ReadonlySet<string> = new Set(
  ARTIFACT_TOOLS.map((tool) => tool.name),
);

export async function executeArtifactTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (name !== "artifact_publish") return failure(`Unknown tool: ${name}`);
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) return failure("artifact_publish requires a `path` inside the sandbox.");
  if (requiresUserProofPurpose(path) && args.purpose !== "user_requested_proof") {
    return failure(
      "Private desktop inspection screenshots can only be published when the user explicitly requested durable proof. Retry artifact_publish with purpose=user_requested_proof for the final requested screenshot only.",
    );
  }
  try {
    const published = await publishSandboxArtifact({
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
        `(${published.artifact.size_bytes} bytes) as artifact ${published.artifact.id}.`,
      { artifact: published.artifact, created: published.created },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "artifact publish failed";
    return failure(`Could not publish ${path}: ${message}`);
  }
}
