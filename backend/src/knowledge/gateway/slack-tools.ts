import { findSlackThreadByRoot } from "../../slack/repo";
import { enqueueUploadFile } from "../../slack/outbox";
import {
  publishSandboxArtifact,
  resolveArtifactForThread,
} from "../../artifacts/publish";
import type { ToolTokenClaims } from "./token";

// ---------------------------------------------------------------------------
// Agent-callable Slack tool. A Slack-originated run can deliver an existing
// durable artifact id or publish a sandbox path first. Browser and Slack reads
// resolve the same immutable bytes; the bot token never leaves the backend, and
// identity (org/thread/run) comes only from the verified gateway token.
//
// Ported from the QM bot (files.uploadV2, reference-eval src/slack/attachments.ts) and
// reference-bot (files_upload_v2, client.py:354). Deviations forced by skynet's
// architecture: sources upload from a local path; our file is in a remote
// sandbox, so the trusted backend performs one bounded pull into shared artifact
// storage, then the crash-durable outbox references that artifact id.
// ---------------------------------------------------------------------------

interface TextContent {
  type: "text";
  text: string;
}
interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}

const toolText = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const toolError = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** MCP tool descriptors. The description doubles as the run's context framing
 *  (item 6b): a Slack run learns, just by seeing this tool, to deliver files
 *  back rather than only describe them. No org/run field - identity is the token. */
export const SLACK_TOOLS = [
  {
    name: "slack_upload",
    description:
      "Deliver a file you produced (screenshot, video, PDF, report - any artifact) " +
      "back to the Slack thread this task came from. Pass the file's path inside " +
      "your sandbox. Prefer this over only describing or linking a file: when the " +
      "request came from Slack, uploading the real file is what the user wants. " +
      "Available only for tasks that originated from Slack.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the file inside your sandbox. Used only when artifactId is absent.",
        },
        artifactId: {
          type: "string",
          description:
            "Preferred durable artifact id returned by artifact_publish; avoids a second sandbox pull.",
        },
        title: {
          type: "string",
          description: "Optional title shown above the file in Slack.",
        },
      },
      anyOf: [{ required: ["artifactId"] }, { required: ["path"] }],
      additionalProperties: false,
    },
  },
] as const;

export const SLACK_TOOL_NAMES = new Set<string>(SLACK_TOOLS.map((t) => t.name));

/** Execute a Slack tool under already-verified claims. Returns an MCP tool
 *  result (never throws) - a truthful message on every outcome. */
export async function executeSlackTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (name !== "slack_upload") return toolError(`Unknown tool: ${name}`);

  const path = typeof args.path === "string" ? args.path.trim() : "";
  const artifactId = typeof args.artifactId === "string" ? args.artifactId.trim() : "";
  if (!path && !artifactId) {
    return toolError("slack_upload requires an `artifactId` or sandbox `path`.");
  }
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;

  // Gate: only Slack-originated runs (their thread maps to a Slack thread).
  const thread = await findSlackThreadByRoot(claims.threadId);
  if (!thread) {
    return toolError(
      "This run is not linked to a Slack thread, so files cannot be delivered to Slack. Publish the file as an artifact instead (artifact_publish) so the user can download it.",
    );
  }

  let artifact;
  try {
    if (artifactId) {
      const existing = await resolveArtifactForThread({
        orgId: claims.orgId,
        threadId: claims.threadId,
        artifactId,
      });
      if (!existing) return toolError("That artifact is not available in this Slack thread.");
      artifact = existing;
    } else {
      artifact = (
        await publishSandboxArtifact({
          orgId: claims.orgId,
          userId: claims.userId,
          runId: claims.runId,
          threadId: claims.threadId,
          path,
        })
      ).record;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "artifact publish failed";
    return toolError(`Could not prepare ${path || artifactId} for Slack: ${message}`);
  }

  // Durable delivery reads the SAME immutable bytes as the browser endpoint.
  await enqueueUploadFile({
    idempotencyKey: `slack-upload:${claims.threadId}:${artifact.id}:${thread.channel}:${thread.threadTs}`,
    channel: thread.channel,
    threadTs: thread.threadTs,
    filename: artifact.name,
    title,
    artifactId: artifact.id,
    size: artifact.sizeBytes,
  });

  return toolText(
    `Queued ${artifact.name} (${artifact.sizeBytes} bytes) for delivery to the Slack thread from artifact ${artifact.id}.`,
  );
}
