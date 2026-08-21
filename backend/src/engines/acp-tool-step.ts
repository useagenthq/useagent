import type { EmitStep } from "./types";
import { basename, truncate } from "./util";

const ACP_FILE_KINDS = new Set(["edit", "delete", "move", "read"]);
const CODEX_SUBAGENT_TOOLS = new Map<string, CodexSubagentActivity>([
  ["spawn_agent", "spawn"],
  ["send_message", "interact"],
  ["send_input", "interact"],
  ["followup_task", "interact"],
  ["resume_agent", "interact"],
  ["wait_agent", "wait"],
  ["wait", "wait"],
  ["close_agent", "close"],
  ["close", "close"],
  ["interrupt_agent", "interrupt"],
  ["interrupt", "interrupt"],
]);

export interface AcpToolNativeIds {
  readonly sessionID: string;
  readonly messageID: string;
  readonly partID: string;
  readonly callID: string;
}

type CodexSubagentActivity = "spawn" | "interact" | "wait" | "close" | "interrupt";

interface CodexSubagentInfo {
  readonly activity: CodexSubagentActivity;
  readonly threadId?: string;
  readonly path?: string;
  readonly name?: string;
  readonly prompt?: string;
}

type AcpToolNativeCode = AcpToolNativeIds & {
  readonly childSessionID?: string;
  readonly parentSessionID?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const rawInputOf = (update: Record<string, unknown>): Record<string, unknown> =>
  isRecord(update.rawInput) ? update.rawInput : {};

function nestedRecord(
  record: Record<string, unknown>,
  ...path: readonly string[]
): Record<string, unknown> | undefined {
  let current: Record<string, unknown> | undefined = record;
  for (const segment of path) {
    const next: unknown = current?.[segment];
    if (!isRecord(next)) return undefined;
    current = next;
  }
  return current;
}

function normalizeSubagentActivity(value: string | undefined): CodexSubagentActivity | undefined {
  if (!value) return undefined;
  const key = value.trim().toLowerCase();
  if (key === "started" || key === "start" || key === "spawned" || key === "spawn") {
    return "spawn";
  }
  if (key === "interacted" || key === "interact") return "interact";
  if (key === "waited" || key === "waiting") return "wait";
  if (key === "closed" || key === "closing") return "close";
  if (key === "interrupted" || key === "interrupting") return "interrupt";
  if (/^(start|spawn)\s+subagent\b/.test(key)) return "spawn";
  if (/^interact\s+with\s+subagent\b/.test(key)) return "interact";
  if (/^wait\s+(for\s+)?subagent\b/.test(key)) return "wait";
  if (/^close\s+subagent\b/.test(key)) return "close";
  if (/^interrupt\s+subagent\b/.test(key)) return "interrupt";
  return CODEX_SUBAGENT_TOOLS.get(key);
}

function subagentName(path: string | undefined, title: string): string | undefined {
  if (path) {
    const name = path.split("/").filter(Boolean).at(-1);
    if (name) return name;
  }
  const match = /subagent\s+(.+)$/i.exec(title);
  return match?.[1]?.trim() || undefined;
}

function subagentPrompt(rawInput: Record<string, unknown>): string | undefined {
  return (
    readString(rawInput.description) ??
    readString(rawInput.prompt) ??
    readString(rawInput.task)
  );
}

function readSubagentInfo(
  update: Record<string, unknown>,
  rawInput: Record<string, unknown>,
  title: string,
): CodexSubagentInfo | undefined {
  const meta = nestedRecord(update, "_meta", "codex", "subagent");
  const metaActivity = normalizeSubagentActivity(readString(meta?.activity));
  const inputActivity = normalizeSubagentActivity(readString(rawInput.activityKind));
  const titleActivity = normalizeSubagentActivity(title);
  const activity = metaActivity ?? inputActivity ?? titleActivity;
  if (!activity) return undefined;

  const threadId =
    readString(meta?.threadId) ??
    readString(rawInput.agentThreadId) ??
    readString(rawInput.threadId) ??
    readString(rawInput.agentId) ??
    readString(rawInput.sessionID) ??
    readString(rawInput.sessionId);
  const path = readString(meta?.path) ?? readString(rawInput.agentPath);
  const prompt = subagentPrompt(rawInput);
  const name =
    subagentName(path, title) ??
    readString(rawInput.name) ??
    readString(rawInput.agent) ??
    (activity === "spawn" ? prompt : undefined);

  return {
    activity,
    ...(threadId ? { threadId } : {}),
    ...(path ? { path } : {}),
    ...(name ? { name } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

function subagentActionLabel(activity: CodexSubagentActivity): string {
  switch (activity) {
    case "spawn":
      return "Subagent";
    case "interact":
      return "Interact";
    case "wait":
      return "Wait";
    case "close":
      return "Close";
    case "interrupt":
      return "Interrupt";
  }
}

function buildSubagentLabel(info: CodexSubagentInfo): string {
  const target = info.prompt ?? info.name ?? info.threadId ?? "subagent";
  if (info.activity === "spawn") return `Subagent — ${truncate(target, 50)}`;
  return `↳ ${subagentActionLabel(info.activity)} — ${truncate(target, 50)}`;
}

function augmentNative(
  native: AcpToolNativeIds | undefined,
  info: CodexSubagentInfo | undefined,
): AcpToolNativeCode | undefined {
  if (!native) return undefined;
  if (!info?.threadId) return native;
  if (info.activity === "spawn") {
    return { ...native, childSessionID: info.threadId };
  }
  return {
    ...native,
    parentSessionID: native.sessionID,
    sessionID: info.threadId,
    childSessionID: info.threadId,
  };
}

function buildAcpToolCode(
  update: Record<string, unknown>,
  output: string | undefined,
  native: AcpToolNativeIds | undefined,
  failed: boolean,
): Record<string, unknown> {
  const kind = String(update.kind ?? "other");
  const title = String(update.title ?? kind);
  const rawInput = rawInputOf(update);
  const subagent = readSubagentInfo(update, rawInput, title);
  const tool = kind === "other" && title.startsWith("mcp__") ? title : kind;
  return {
    tool: subagent ? "subagent" : tool,
    title,
    input: rawInput,
    ...(output !== undefined ? { output: output.slice(0, 2000) } : {}),
    ...(native ? { native: augmentNative(native, subagent) } : {}),
    ...(subagent ? { subagent } : {}),
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

/** Detect an application-level MCP failure even when ACP reports that the
 * transport call itself completed. */
export function acpToolResultFailed(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.some((item) => acpToolResultFailed(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.isError === true) return true;
  if (record.status === "failed" || record.status === "error") return true;
  if (record.error !== undefined && record.error !== null && record.error !== false) return true;
  for (const nested of [record.result, record.structuredContent, record.content, record.data]) {
    if (acpToolResultFailed(nested, depth + 1)) return true;
  }
  return false;
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
  const rawInput = rawInputOf(update);
  const subagent = readSubagentInfo(update, rawInput, title);
  const path = String(rawInput.file_path ?? rawInput.path ?? rawInput.abs_path ?? "");
  const isFile = ACP_FILE_KINDS.has(kind) && kind !== "read";
  const label =
    subagent
      ? buildSubagentLabel(subagent)
      : kind === "execute"
      ? truncate(String(rawInput.command ?? title))
      : path
        ? isFile
          ? basename(path)
          : `${title.split(" ")[0]} ${basename(path)}`
        : truncate(title, 60);

  return {
    kind: isFile ? "file" : kind === "task" || subagent ? "task" : "command",
    label,
    chip:
      subagent
        ? subagent.activity === "spawn"
          ? "subagent"
          : "task"
        : kind === "execute"
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
