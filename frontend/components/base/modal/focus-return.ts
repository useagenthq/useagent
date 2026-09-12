import { useRef } from "react";

/**
 * Focus return for the dialog primitives (Modal, Drawer).
 *
 * The underlying dialog content always cancels the default close autofocus and
 * focuses its `Trigger` instead. A controlled `Root` opened from a plain
 * onClick has no trigger, so after Esc or Cancel focus fell to <body>. This
 * remembers the element that had focus when the dialog opened and hands focus
 * back to it on close, as long as it is still in the document.
 */
export function useFocusReturn() {
  const openerRef = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      openerRef.current = document.activeElement as HTMLElement | null;
    },
    onCloseAutoFocus: (event: Event) => {
      restoreFocus(openerRef.current, event);
    },
  };
}

/** Focus `opener` and cancel the dialog's own close autofocus. Leaves the
 *  default behaviour alone when there is nothing sensible to return to. */
export function restoreFocus(opener: HTMLElement | null, event: Event): void {
  if (!opener || !opener.isConnected || opener.tagName === "BODY") return;
  event.preventDefault();
  opener.focus();
}
