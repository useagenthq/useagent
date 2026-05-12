import type { EmitStep } from "./types";
import { basename, truncate } from "./util";

const ACP_FILE_KINDS = new Set(["edit", "delete", "move", "read"]);

export interface AcpToolNativeIds {
  readonly sessionID: string;
  readonly messageID: string;
  readonly partID: string;
  readonly callID: string;
}

function buildAcpToolCode(
  update: Record<string, unknown>,
  output: string | undefined,
  native: AcpToolNativeIds | undefined,
  failed: boolean,
): Record<string, unknown> {
  const kind = String(update.kind ?? "other");
  const title = String(update.title ?? kind);
  const tool = kind === "other" && title.startsWith("mcp__") ? title : kind;
  return {
    tool,
    title,
    input: (update.rawInput ?? {}) as Record<string, unknown>,
    ...(output !== undefined ? { output: output.slice(0, 2000) } : {}),
    ...(native ? { native } : {}),
    ...(failed ? { error: true } : {}),
  };
}

/** Persist the terminal state using the exact same normalization as the opening
 * tool row. ACP reports MCP methods as kind=`other`; rebuilding this payload by
 * hand used to overwrite the real `mcp__…` name when the result arrived, making
 * completed browser actions render as the meaningless label “Other”. */
export function buildAcpToolCompletion(
  update: Record<string, unknown>,
  output: string,
  native: AcpToolNativeIds | undefined,
  failed: boolean,
): Record<string, unknown> {
  return {
    ...buildAcpToolCode(update, output, native, failed),
    status: failed ? "failed" : "completed",
  };
}

/** Translate one ACP tool notification into the provider-neutral step contract. */
export function buildAcpToolStep(
  update: Record<string, unknown>,
  output: string | undefined,
  native?: AcpToolNativeIds,
  failed = false,
): EmitStep {
  const kind = String(update.kind ?? "other");
  const title = String(update.title ?? kind);
  const tool = kind === "other" && title.startsWith("mcp__") ? title : kind;
  const rawInput = (update.rawInput ?? {}) as Record<string, unknown>;
  const path = String(rawInput.file_path ?? rawInput.path ?? rawInput.abs_path ?? "");
  const isFile = ACP_FILE_KINDS.has(kind) && kind !== "read";
  const label =
    kind === "execute"
      ? truncate(String(rawInput.command ?? title))
      : path
        ? isFile
          ? basename(path)
          : `${title.split(" ")[0]} ${basename(path)}`
        : truncate(title, 60);

  return {
    kind: isFile ? "file" : kind === "task" ? "task" : "command",
    label,
    chip:
      kind === "execute"
        ? "bash"
        : kind === "task"
          ? "subagent"
          : isFile
            ? "file"
            : tool.startsWith("mcp__")
              ? "mcp"
              : kind,
    code_json: buildAcpToolCode(update, output, native, failed),
  };
}
