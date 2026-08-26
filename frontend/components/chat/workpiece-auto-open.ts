import type { OrgChange } from "@/lib/org-changes";

/** The artifact id to auto-open into the Workspace pane, or null.
 *
 * Thread-scoped and live-only by construction: the org invalidation stream emits
 * "created" ONCE, in real time, when a workpiece is first published - never on a
 * historical thread load - and carries the `threadId` of the run that produced
 * it. Gating on `action === "created"` and `threadId === rootThreadId` therefore
 * auto-opens only a workpiece born in the currently-viewed thread, never a
 * mainline "updated" / a proposal "proposed", never another thread's signal, and
 * never a reopened session's backlog. The caller still fetches the descriptor to
 * confirm it is a canonical workpiece (a raw binary keeps its card/download). */
export function autoOpenArtifactId(change: OrgChange, rootThreadId: string): string | null {
  if (change.type !== "artifact") return null;
  if (change.action !== "created") return null;
  if (change.threadId !== rootThreadId) return null;
  return change.artifactId;
}

/** Whether an auto-opened workpiece may take focus (become the active tab).
 *
 * Default yes: bring the new tab forward. The one exception is an editor the user
 * is actively working in - if the active workpiece surface both holds DOM focus
 * AND has unsaved edits, switching away would yank the caret mid-typing, so the
 * new tab is added quietly (a subtle highlight) instead. Pure so the no-steal
 * rule is unit-locked. */
export function shouldFocusAutoOpened(active: {
  readonly dirty: boolean;
  readonly focused: boolean;
}): boolean {
  return !(active.dirty && active.focused);
}

/** True when DOM focus sits inside a live workspace editing surface - the signal
 * an auto-open uses to avoid yanking the caret away from an edit in progress.
 * `visibility:hidden` on an inactive tab drops focus, so a focused surface is by
 * definition the visible one. */
export function workspaceSurfaceHasFocus(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return active instanceof HTMLElement && active.closest("[data-workspace-surface]") !== null;
}
