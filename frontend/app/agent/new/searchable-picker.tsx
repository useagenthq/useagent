"use client";

import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { RiArrowDownSLine, RiCheckLine } from "@remixicon/react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandItemGlyph,
  CommandList,
} from "@/components/base/command/command";
import {
  Dropdown,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import { cx } from "@/utils/cx";

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

export interface PickerOption {
  value: string;
  label: string;
  /** Secondary line under the label (e.g. a skill's tag). */
  caption?: string;
  /** Leading remixicon (folder, disk…). */
  icon?: IconComponent;
  /** When set, render a tinted ✳ mark instead of an icon (model marks). */
  markTint?: string;
  /** Monospace label styling (machine snapshots). */
  mono?: boolean;
}

export interface PickerGroup {
  label?: string;
  /** Trailing affordance on the group heading (e.g. the Free-lane refresh). */
  action?: ReactNode;
  options: PickerOption[];
}

export interface SearchablePickerProps {
  ariaLabel: string;
  /** Shown in the trigger when nothing is selected. */
  triggerLabel: string;
  searchPlaceholder: string;
  groups: PickerGroup[];
  value: string;
  onChange: (value: string) => void;
  /** Override the trigger styling (e.g. render as a full-width menu row). */
  triggerClassName?: string;
  /** Drop the trailing chevron (e.g. when this picker is the left half of a
   *  combined engine + model chip and a single chevron reads cleaner). */
  hideChevron?: boolean;
}

function OptionMark({ option }: { option: PickerOption }) {
  if (option.markTint) {
    return <AsteriskMark className={cx("size-4 shrink-0", option.markTint)} />;
  }
  if (option.icon) {
    const Icon = option.icon;
    return <Icon className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />;
  }
  return null;
}

/**
 * Searchable single-select picker: a BoardUI Dropdown trigger over the shared
 * Command list grammar (components/base/command) - search row, sectioned
 * groups, keyboard nav, checkmark on the active row, all on one alignment
 * grid. The trigger reflects the current selection (its mark/icon + label),
 * matching the composer's other controls.
 */
export function SearchablePicker({
  ariaLabel,
  triggerLabel,
  searchPlaceholder,
  groups,
  value,
  onChange,
  triggerClassName,
  hideChevron = false,
}: SearchablePickerProps) {
  const [open, setOpen] = useState(false);

  const selected = useMemo(() => {
    for (const group of groups) {
      for (const option of group.options) {
        if (option.value === value) return option;
      }
    }
    return undefined;
  }, [groups, value]);

  // One left inset for every row: when any option carries a glyph, all rows
  // render the fixed leading column so plain labels share the same edge.
  const hasGlyphs = groups.some((g) => g.options.some((o) => o.icon || o.markTint));
  const searchActions = groups.flatMap((group, index) =>
    group.action ? [<span key={group.label ?? index}>{group.action}</span>] : [],
  );

  function pick(next: string) {
    onChange(next);
    setOpen(false);
  }

  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <DropdownTrigger
        aria-label={ariaLabel}
        className={cx(
          "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-body-2-medium text-text-primary outline-none transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          triggerClassName,
        )}
      >
        {selected ? <OptionMark option={selected} /> : null}
        <span
          title={selected?.label ?? triggerLabel}
          className={cx("truncate", selected?.mono && "font-mono text-caption-1-regular")}
        >
          {selected?.label ?? triggerLabel}
        </span>
        {hideChevron ? null : (
          <RiArrowDownSLine
            className={cx(
              "size-4 shrink-0 text-foreground-icon-secondary transition-transform duration-200",
              open && "rotate-180",
            )}
            aria-hidden
          />
        )}
      </DropdownTrigger>
      <DropdownPopover
        aria-label={ariaLabel}
        placement="bottom start"
        offset={6}
        className="w-[264px]"
      >
        <Command label={ariaLabel} defaultValue={selected ? selected.value || selected.label : undefined}>
          <CommandInput
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            trailing={searchActions.length > 0 ? searchActions : undefined}
          />
          <CommandList>
            <CommandEmpty>No results</CommandEmpty>
            {groups.map((group, groupIndex) => (
              <CommandGroup key={group.label ?? groupIndex} heading={group.label}>
                {group.options.map((option) => (
                  <CommandItem
                    key={option.value || option.label}
                    value={option.value || option.label}
                    keywords={[option.label, ...(option.caption ? [option.caption] : [])]}
                    onSelect={() => pick(option.value)}
                  >
                    {hasGlyphs ? (
                      <CommandItemGlyph>
                        <OptionMark option={option} />
                      </CommandItemGlyph>
                    ) : null}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={cx(
                          "truncate",
                          option.mono && "font-mono text-caption-1-regular",
                        )}
                      >
                        {option.label}
                      </span>
                      {option.caption ? (
                        <span className="truncate text-caption-1-regular text-text-tertiary">
                          {option.caption}
                        </span>
                      ) : null}
                    </span>
                    {option.value === value ? (
                      <RiCheckLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DropdownPopover>
    </Dropdown>
  );
}
