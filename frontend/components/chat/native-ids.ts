// Canonical reader for the native OpenCode ids the backend stamps into a step's
// `code_json.native` (commit 83c6439). ONE reader, shared by the native session
// store (`native-store.ts`) and subagent attribution (`subagents.ts`) — neither
// re-parses the same wire shape. One pattern per concern.

import { asRecord, parseStepCode, type ApiStep } from "./types";

/** The native OpenCode ids a step may carry under `code_json.native`. A tool/file
 *  step carries the session it ran in (`sessionID` — the root session for the
 *  primary agent, a child session for a subagent's own work); a subagent spawn
 *  additionally carries the child session it launched (`childSessionID`, the
 *  subtask-part path). */
export interface NativeIds {
  readonly sessionID?: string;
  readonly messageID?: string;
  readonly partID?: string;
  readonly callID?: string;
  readonly childSessionID?: string;
}

export const readString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Read the stamped native ids off a step, or null for pre-83c6439 runs. */
export function nativeOf(step: ApiStep): NativeIds | null {
  const code = asRecord(parseStepCode(step));
  const native = code ? asRecord(code.native) : null;
  if (!native) return null;
  return {
    sessionID: readString(native.sessionID),
    messageID: readString(native.messageID),
    partID: readString(native.partID),
    callID: readString(native.callID),
    childSessionID: readString(native.childSessionID),
  };
}
