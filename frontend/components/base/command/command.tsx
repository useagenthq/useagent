"use client";

import { RiSearchLine } from "@remixicon/react";
import { Command as CommandPrimitive } from "cmdk";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "@/utils/cx";

/**
 * Command - the searchable-list grammar for popover pickers, built on cmdk
 * (MIT) for filtering, keyboard nav (arrows / Enter / type-ahead) and item
 * selection. This is the LIST half of a picker: the caller owns the surface
 * (DropdownPopover, Modal, ...) and composes
 *
 * ```tsx
 * <Command label="...">
 *   <CommandInput placeholder="Search..." />
 *   <CommandList>
 *     <CommandEmpty>No results</CommandEmpty>
 *     <CommandGroup heading="Engines">
 *       <CommandItem value="..." onSelect={...}>
 *         <CommandItemGlyph>{icon}</CommandItemGlyph>
 *         ...label / caption...
 *       </CommandItem>
 *     </CommandGroup>
 *   </CommandList>
 * </Command>
 * ```
 *
 * One alignment grid, sized to the menu density pass (panel p-1.5, 32px rows,
 * 13px labels): the search icon, group headings and item glyphs all start
 * 14px from the panel edge - the search row bleeds to the panel edge
 * (-mx-1.5 + px-3.5 = 14px), rows and headings are px-2 inside the panel's
 * 6px padding (6 + 8 = 14px). Leading glyphs sit in a fixed 16px column
 * (CommandItemGlyph), so row text and the search input share one left edge
 * too (14 + 16 + 8px gap).
 */

/** Order-preserving substring filter over the item's value + keywords - the
 *  pickers' original behavior (no fuzzy re-ranking; groups keep their order). */
export function commandSubstringFilter(
  value: string,
  search: string,
  keywords?: string[],
): number {
  const query = search.trim().toLowerCase();
  if (!query) return 1;
  const haystack = [value, ...(keywords ?? [])].join(" ").toLowerCase();
  return haystack.includes(query) ? 1 : 0;
}

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      filter={commandSubstringFilter}
      className={cx("flex min-w-0 flex-col outline-none", className)}
      {...props}
    />
  );
}

/** The 32px search row: full-bleed under the panel's top edge, bottom-ruled,
 *  with the search glyph in the same 16px leading column as item glyphs. */
export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="-mx-1.5 -mt-1.5 mb-1 flex h-8 shrink-0 items-center gap-2 border-b border-border-button-default px-3.5">
      <span className="flex w-4 shrink-0 items-center justify-center">
        <RiSearchLine className="size-4 text-foreground-icon-tertiary" aria-hidden />
      </span>
      {/* The popover is non-modal (no focus trap), so focus stays on the
          trigger unless the input claims it - autofocus makes type-ahead and
          arrow/Enter nav work the moment the picker opens. */}
      <CommandPrimitive.Input
        autoFocus
        className={cx(
          "h-full min-w-0 flex-1 bg-transparent text-body-2-medium text-text-primary outline-none placeholder:text-text-tertiary",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cx(
        "max-h-[264px] overflow-y-auto overscroll-contain",
        "[&_[cmdk-list-sizer]]:flex [&_[cmdk-list-sizer]]:flex-col [&_[cmdk-list-sizer]]:gap-1",
        className,
      )}
      {...props}
    />
  );
}

export interface CommandGroupProps
  extends Omit<ComponentProps<typeof CommandPrimitive.Group>, "heading"> {
  heading?: ReactNode;
  /** Trailing affordance on the heading row (e.g. the Free-lane refresh). */
  action?: ReactNode;
}

export function CommandGroup({ heading, action, className, ...props }: CommandGroupProps) {
  return (
    <CommandPrimitive.Group
      heading={
        heading ? (
          <>
            <span className="truncate">{heading}</span>
            {action}
          </>
        ) : undefined
      }
      className={cx(
        // Heading: 24px row on the rows' left inset, mono micro-label.
        "[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-6 [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:justify-between [&_[cmdk-group-heading]]:gap-2 [&_[cmdk-group-heading]]:px-2",
        "[&_[cmdk-group-heading]]:text-mono-label [&_[cmdk-group-heading]]:text-text-tertiary",
        "[&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-col [&_[cmdk-group-items]]:gap-0.5",
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cx(
        "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-2lg px-2 py-1 text-body-2-medium text-text-primary outline-none",
        "data-[selected=true]:bg-dropdown-item-hover-background",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/** Fixed 16px leading column so every row's text starts on the same edge,
 *  glyph or not. Render it empty for options without an icon or mark. */
export function CommandItemGlyph({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={cx(
        "flex w-4 shrink-0 items-center justify-center text-foreground-icon-secondary",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function CommandEmpty({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className={cx("px-2 py-2 text-body-2-medium text-text-tertiary", className)}
      {...props}
    />
  );
}
