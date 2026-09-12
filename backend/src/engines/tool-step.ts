import type { EmitStep } from "./types";
import { basename, truncate } from "./util";

const FILE_TOOLS = new Set(["write", "edit", "patch", "multiedit"]);

/** Render one provider tool call as a step in the shared trace grammar. The
 *  opencode Part model and the Pi bridge both land here, so every engine's
 *  `command` rows carry the command (and later its output) and every `file`
 *  row carries the path: the timeline, the terminal log, the editor rail and
 *  Stop's mid-flight check all read this one shape. */
export function toolStep(
  tool: string,
  input: Record<string, unknown>,
  title: string | undefined,
  output: string | undefined,
): EmitStep {
  const code = { tool, input, ...(output !== undefined ? { output } : {}) };
  if (tool === "task") {
    const desc = String(input.description ?? title ?? "subagent");
    return {
      kind: "task",
      label: `Subagent — ${truncate(desc, 50)}`,
      chip: "subagent",
      code_json: code,
    };
  }
  const isFile = FILE_TOOLS.has(tool.toLowerCase());
  const filePath =
    (input.filePath as string) ?? (input.file_path as string) ?? (input.path as string) ?? "";
  const label = isFile
    ? filePath
      ? basename(filePath)
      : title ?? tool
    : (input.command as string) ?? title ?? (filePath ? `${tool} ${basename(filePath)}` : tool);
  return {
    kind: isFile ? "file" : "command",
    label: truncate(String(label)),
    chip: isFile ? "file" : tool === "bash" ? "bash" : tool,
    code_json: code,
  };
}
