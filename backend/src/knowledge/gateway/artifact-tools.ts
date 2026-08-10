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

export const ARTIFACT_TOOLS = [
  {
    name: "artifact_publish",
    description:
      "Publish a file from your sandbox as a durable Skynet artifact. The trusted " +
      "backend pulls and size-checks the bytes once, records an immutable digest, " +
      "and returns browser preview/download references. Use this for screenshots, " +
      "reports, PDFs, presentations, spreadsheets, videos, and other outputs the user needs.",
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
  try {
    const published = await publishSandboxArtifact({
      orgId: claims.orgId,
      userId: claims.userId,
      runId: claims.runId,
      threadId: claims.threadId,
      path,
      ...(typeof args.name === "string" && args.name.trim()
        ? { name: args.name.trim() }
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
