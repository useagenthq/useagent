/**
 * What closing a Workspace tab does. A tab whose editor holds edits that are
 * not saved yet (typed inside the autosave delay, or left after a failed save)
 * asks Save or Discard first; every other tab closes at once. Closing unmounts
 * the editor, which cancels its pending autosave, so a silent close would lose
 * those edits.
 */
export type WorkpieceCloseStep = "close" | "ask";

/** The open editor's state, or undefined while it is still loading or failed to load. */
export interface WorkpieceCloseState {
  readonly dirty: boolean;
}

export function workpieceCloseStep(editor: WorkpieceCloseState | undefined): WorkpieceCloseStep {
  return editor?.dirty ? "ask" : "close";
}
