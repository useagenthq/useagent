"use client";

import { hideOthers } from "aria-hidden";
import { type RefObject, useEffect } from "react";

const TABBABLE_CANDIDATES =
  'a[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable="true"]';

/** What Tab can actually land on: the rail keeps visited panes mounted but
 *  hidden, and shows different header buttons at each width. */
function tabbableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE_CANDIDATES)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      !element.closest('[inert], [aria-hidden="true"]') &&
      (element.checkVisibility?.({ visibilityProperty: true }) ?? true),
  );
}

/** The top-level page element holding `element`. Portalled layers (the command
 *  palette, the nav drawer) sit beside it, directly under <body>. */
function pageRootOf(element: HTMLElement): HTMLElement {
  let root = element;
  while (root.parentElement && root.parentElement !== document.body) root = root.parentElement;
  return root;
}

/** Dialog semantics, present only while the panel is one: the same element is an
 *  ordinary region side by side. */
export function sheetDialogProps(open: boolean, label: string) {
  return open
    ? { role: "dialog" as const, "aria-modal": true as const, "aria-label": label, tabIndex: -1 }
    : {};
}

/**
 * The WAI-ARIA modal dialog pattern for a panel that must stay mounted. It cannot
 * move into a portalled primitive (Modal, Drawer): the side panel's terminal,
 * browser and editors keep their state in place when it becomes a sheet. It
 * cannot use a native dialog's showModal() either: the top layer would sit above
 * the command palette and leave it inert, and the palette has to open over this.
 *
 * While `open`, focus moves into `dialogRef`, the rest of the page is hidden from
 * screen readers, Escape calls `onDismiss` (a stable callback) and Tab wraps at
 * the panel's edges. Only the edges are handled: a pane that uses Tab itself (the
 * terminal) marks the key handled or stops it first. Layers above the sheet keep
 * their own focus and Escape, but focus that lands on the page behind it (a
 * closing nav drawer returning to its trigger) comes back.
 *
 * On close focus returns to what held it at open. That can be nothing, since
 * iOS Safari does not focus a tapped button and an agent can open the sheet
 * itself, so `fallbackFocusRef` names a control that is always there.
 */
export function useSheetDialog(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  fallbackFocusRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;

    const active = document.activeElement;
    const alreadyInside = active !== null && dialog.contains(active);
    const opener =
      active instanceof HTMLElement && active !== document.body && !alreadyInside ? active : null;
    if (!alreadyInside) dialog.focus({ preventScroll: true });
    const showOthers = hideOthers(dialog);
    const pageRoot = pageRootOf(dialog);

    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") onDismiss();
      if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement;
      const inside = dialog.contains(target);
      // Focus on <body> means the focused control just went away (a closed
      // tab): Tab would otherwise walk the page behind the sheet.
      if (!inside && target !== document.body) return;
      if (inside && target.closest('[role="dialog"]') !== dialog) return;

      const tabbable = tabbableIn(dialog);
      const first = tabbable[0] ?? dialog;
      const last = tabbable[tabbable.length - 1] ?? dialog;
      const wraps = event.shiftKey
        ? !inside || target === first || target === dialog
        : !inside || target === last;
      if (!wraps) return;
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    };
    const returnStrayFocus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (pageRoot.contains(target) && !dialog.contains(target)) {
        dialog.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("focusin", returnStrayFocus);

    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("focusin", returnStrayFocus);
      showOthers();
      // Still on screen and usable: the window widened past the sheet, so the
      // panel is side by side again and focus can stay where it is.
      if (dialog.isConnected && !dialog.hasAttribute("inert")) return;
      for (const target of [opener, fallbackFocusRef.current]) {
        target?.focus();
        if (target && document.activeElement === target) return;
      }
    };
  }, [open, dialogRef, fallbackFocusRef, onDismiss]);
}
