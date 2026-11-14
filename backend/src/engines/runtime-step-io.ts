// The input and output a runtime tool activity contributes to its durable step.
// The native runtime projects tool payloads before they reach this adapter, so
// two shapes need repair here: file changes whose path survives only in the
// projection's `files[]` list or in the Claude adapter's detail string, and
// command items whose captured output sits under `data.item`.

import type { RuntimeEngineId } from "./runtime-orchestration";

type Rec = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function stringField(value: unknown, key: string): string | null {
  const field = asRecord(value)?.[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

const FILE_PATH_KEYS = ["file_path", "filePath", "path", "filename", "notebook_path"] as const;

/** Where a file change's input holds its text: the string an edit replaced and
 * the string it put there (a whole file written has only the second). These
 * are two of the forms the Diff pane builds a file's diff from. */
const FILE_CHANGE_TEXT_KEYS: readonly string[] = ["old_string", "new_string"];
const utf8 = new TextEncoder();

/** The UTF-8 size of the text a file change's input, or the `data` it is read
 * from, holds; 0 when it holds none. */
export function fileChangeTextBytes(value: unknown): number {
  const holder = asRecord(value);
  if (!holder) return 0;
  return FILE_CHANGE_TEXT_KEYS.reduce((bytes, key) => {
    const text = holder[key];
    return typeof text === "string" ? bytes + utf8.encode(text).byteLength : bytes;
  }, 0);
}

/** A file change's payload without the text in its `data`. */
export function withoutFileChangeText<Payload>(payload: Payload): Payload {
  const whole = asRecord(payload);
  const data = asRecord(whole?.data);
  if (!whole || !data || !FILE_CHANGE_TEXT_KEYS.some((key) => key in data)) return payload;
  const rest = Object.fromEntries(Object.entries(data).filter(([key]) => !FILE_CHANGE_TEXT_KEYS.includes(key)));
  return { ...whole, data: rest } as Payload;
}

/** The copy of a tool activity's payload its step keeps next to `input`. A
 * file change's text is in the input, so this copy leaves it out. */
export function stepActivityPayload(itemType: string | null, input: unknown, payload: unknown): unknown {
  return itemType === "file_change" && fileChangeTextBytes(input) > 0 ? withoutFileChangeText(payload) : payload;
}

/**
 * Every path a projected file change names. The runtime's activity projection
 * rewrites file tool inputs to `files:[{path}]` and its collector does not know
 * Claude's `file_path`, so a Claude edit reaches this adapter with no path in its
 * data at all; the only copy is the `detail` string the Claude adapter builds
 * from the tool input (`Write: {"file_path":"…"}`), read here as a last resort.
 */
export function runtimeFilePaths(input: unknown, detail: string | undefined): string[] {
  const paths: string[] = [];
  const push = (path: string | null): void => {
    if (path && !paths.includes(path)) paths.push(path);
  };
  const data = asRecord(input);
  const files = Array.isArray(data?.files) ? data.files : [];
  for (const entry of files) push(stringField(entry, "path"));
  for (const key of FILE_PATH_KEYS) push(stringField(data, key));
  if (paths.length === 0 && detail) {
    const match = /"(?:file_path|filePath|path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(detail);
    if (match) {
      try {
        push(JSON.parse(`"${match[1]}"`) as string);
      } catch {
        // Not a JSON string literal after all; the row stays path-less.
      }
    }
  }
  return paths;
}

/** File-change input with one uniform shape for the UI: `file_path` names the
 * first file and `files` lists every one (the runtime's own entries kept when
 * present, since they may carry a change kind). The change's text, when the
 * runtime sent it, stays under its own keys (FILE_CHANGE_TEXT_KEYS). */
function fileChangeInput(input: unknown, detail: string | undefined): unknown {
  const paths = runtimeFilePaths(input, detail);
  if (paths.length === 0) return input;
  const data = asRecord(input) ?? {};
  const files = Array.isArray(data.files) && data.files.length > 0
    ? data.files
    : paths.map((path) => ({ path }));
  return { ...data, file_path: paths[0], files };
}

/** Command input with the command line where the UI reads it. The runtime keeps
 * Codex's command under `data.item.command` (or `item.input.command`), which the
 * UI never walks; an input that already names its command is left alone. */
function commandInput(input: unknown, item: Rec | null): unknown {
  const data = asRecord(input);
  if (stringField(data, "command")) return input;
  const command = stringField(item, "command")
    ?? stringField(asRecord(item?.input), "command")
    ?? stringField(asRecord(item?.result), "command");
  return command ? { ...(data ?? {}), command } : input;
}

/** The output of a command item. The runtime hands codex its result under
 * `data.item` (`aggregatedOutput`, or `result.content`) and Claude its under
 * `data.rawOutput.content`, both reduced by the runtime to a first-line preview
 * (84 characters); for both, the payload's `detail` is the command line itself
 * (`printf hello`, `Bash: printf hello`, cut at 180 characters), so it is never
 * output. OpenCode's `detail` is the real output once the tool completed (while
 * running it is the tool's title) and its `rawOutput` only a one-line summary,
 * so there the completed detail wins. An unknown engine gets the preview only. */
function commandOutput(
  engine: RuntimeEngineId | null,
  activityKind: string,
  item: Rec | null,
  data: Rec | null,
  detail: string | undefined,
): string | undefined {
  const captured = stringField(item, "aggregatedOutput")
    ?? stringField(asRecord(item?.result), "content")
    ?? stringField(asRecord(data?.rawOutput), "content")
    ?? undefined;
  if (engine === "opencode" && activityKind === "tool.completed") return detail ?? captured;
  return captured;
}

/** The step's `input` and `output` for a tool activity of the given item type. */
export function runtimeStepIo(
  engine: RuntimeEngineId | null,
  activityKind: string,
  itemType: string | null,
  projection: { readonly input: unknown; readonly item: Rec | null; readonly data: Rec | null },
  detail: string | undefined,
): { readonly input: unknown; readonly output: string | undefined } {
  if (itemType === "file_change") {
    return { input: fileChangeInput(projection.input, detail), output: detail };
  }
  if (itemType === "command_execution") {
    return {
      input: commandInput(projection.input, projection.item),
      output: commandOutput(engine, activityKind, projection.item, projection.data, detail),
    };
  }
  return { input: projection.input, output: detail };
}
