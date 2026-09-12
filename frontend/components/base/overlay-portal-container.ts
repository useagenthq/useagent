"use client";

import { createContext, useContext } from "react";

/**
 * Where floating overlays (select listboxes, dropdown panels) should portal
 * to. Radix modal surfaces (Modal, Drawer) trap focus inside their content and
 * turn pointer events off everywhere else, so a popover portalled to <body>
 * cannot be clicked, cannot take keyboard focus, and its Escape closes the
 * whole dialog instead. Those surfaces provide their content element here and
 * the react-aria popovers portal into it. Null means <body>, the default.
 */
export const OverlayPortalContainerContext = createContext<HTMLElement | null>(null);

export function useOverlayPortalContainer(): HTMLElement | undefined {
  return useContext(OverlayPortalContainerContext) ?? undefined;
}

/**
 * Radix hears Escape on the document before the focused popover does. When the
 * key was pressed inside a listbox or a nested dialog (a select or dropdown
 * open inside the surface), the popover owns that Escape and the surface must
 * stay open.
 */
export function escapeBelongsToNestedOverlay(target: EventTarget | null, container: HTMLElement | null): boolean {
  const element = target as Pick<Element, "closest"> | null;
  if (typeof element?.closest !== "function") return false;
  const nested = element.closest('[role="listbox"], [role="dialog"]');
  return nested !== null && nested !== container;
}
