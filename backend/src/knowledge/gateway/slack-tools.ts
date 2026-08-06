import { randomUUID } from "node:crypto";
import { findSlackThreadByRoot } from "../../slack/repo";
import { getRunForOrg } from "../../runs/repo";
import { downloadSandboxFile } from "../../slack/sandbox-file";
import { stageUploadBytes } from "../../slack/upload-staging";
import { enqueueUploadFile } from "../../slack/outbox";
import { recordProviderEvent } from "../../runs/provider-events";
import type { ToolTokenClaims } from "./token";

// ---------------------------------------------------------------------------
// Agent-callable Slack tool (item 6). A Slack-originated run produces artifacts
// in its sandbox (screenshots, a demo video, a report) and had NO way to deliver
// them to the Slack thread. `slack_upload` closes that: the agent passes a
// SANDBOX path; the BACKEND pulls the bytes (Daytona SDK), stages them, and
// durably delivers them into the mapped thread via the outbox. The bot token
// never leaves the server, and identity (org/thread/run) comes ONLY from the
// verified gateway token - a tool argument never carries a tenant/run id.
//
// Ported from the QM bot (files.uploadV2, reference-eval src/slack/attachments.ts) and
// reference-bot (files_upload_v2, client.py:354). Deviations forced by skynet's
// architecture, noted in the commit: (1) sources upload from a local path; our
// file is in a remote sandbox, so we pull it via the Daytona SDK at the trust
// boundary; (2) sources upload inline, but skynet has a crash-durable outbox, so
// we stage the bytes + enqueue an `upload_file` row that survives a restart.
// ---------------------------------------------------------------------------

/** Hard cap on a single delivered artifact. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

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
          description: "Path to the file inside your sandbox (e.g. outputs/demo.mp4).",
        },
        title: {
          type: "string",
          description: "Optional title shown above the file in Slack.",
        },
      },
      required: ["path"],
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
  if (!path) return toolError("slack_upload requires a `path` to a file inside your sandbox.");
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;

  // Gate: only Slack-originated runs (their thread maps to a Slack thread).
  const thread = await findSlackThreadByRoot(claims.threadId);
  if (!thread) {
    return toolError("This run is not linked to a Slack thread, so files cannot be delivered to Slack.");
  }

  const run = await getRunForOrg(claims.orgId, claims.runId);
  if (!run?.sandboxId) {
    return toolError("No sandbox is attached to this run, so there is no file to upload.");
  }

  // Pull the bytes out of the sandbox (size-capped) WHILE it is alive.
  let file;
  try {
    file = await downloadSandboxFile(run.sandboxId, path, MAX_UPLOAD_BYTES);
  } catch (err) {
    return toolError(`Could not read ${path} from the sandbox: ${(err as Error).message}`);
  }

  const filename = path.split("/").filter(Boolean).pop() ?? "file";
  const stagedPath = await stageUploadBytes(filename, file.bytes);

  // Durable delivery: the relay uploads (and retries) even after the sandbox is gone.
  await enqueueUploadFile({
    idempotencyKey: `slack-upload:${randomUUID()}`,
    channel: thread.channel,
    threadTs: thread.threadTs,
    filename,
    title,
    stagedPath,
    size: file.bytes.length,
  });

  // Timeline marker (names + size only, never content) so the web UI shows it.
  await recordProviderEvent({
    id: `artifact.delivered:${claims.runId}:${stagedPath}`,
    runId: claims.runId,
    threadId: claims.threadId,
    provider: "skynet",
    eventType: "artifact.delivered",
    payload: { name: filename, bytes: file.bytes.length },
  }).catch(() => {});

  return toolText(`Delivering ${filename} (${file.bytes.length} bytes) to the Slack thread.`);
}
