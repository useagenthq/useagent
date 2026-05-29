"use client";

import { useMemo, useState, type ComponentType } from "react";
import { RiArrowDownSLine, RiCheckLine, RiSearchLine } from "@remixicon/react";
import {
  Dropdown,
  DropdownItem,
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
}

function OptionMark({ option }: { option: PickerOption }) {
  if (option.markTint) {
    return <AsteriskMark className={cx("size-4 shrink-0", option.markTint)} />;
  }
  if (option.icon) {
    const Icon = option.icon;
    return <Icon className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />;
  }
  return null;
}

/**
 * Cursor-style picker on the BoardUI Dropdown recipe: the panel opens with a
 * search input at the top, then sectioned groups (a "Recents" group first) of
 * selectable rows with a checkmark on the active one. The trigger reflects the
 * current selection (its mark/icon + label), matching the composer's other
 * controls.
 */
export function SearchablePicker({
  ariaLabel,
  triggerLabel,
  searchPlaceholder,
  groups,
  value,
  onChange,
  triggerClassName,
}: SearchablePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = useMemo(() => {
    for (const group of groups) {
      for (const option of group.options) {
        if (option.value === value) return option;
      }
    }
    return undefined;
  }, [groups, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => ({
        ...group,
        options: group.options.filter(
          (o) => o.label.toLowerCase().includes(q) || o.caption?.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.options.length > 0);
  }, [groups, query]);

  function pick(next: string) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  return (
    <Dropdown
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
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
        <RiArrowDownSLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
      </DropdownTrigger>
      <DropdownPopover
        aria-label={ariaLabel}
        placement="bottom start"
        offset={6}
        className="w-[264px]"
      >
        <div className="-mx-2.5 -mt-1 mb-1 flex items-center gap-2 border-b border-border-button-default px-3 pb-2.5 pt-1">
          <RiSearchLine className="size-4 shrink-0 text-foreground-icon-tertiary" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-body-2-medium text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
        <div className="flex max-h-[264px] flex-col gap-1.5 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-2 py-2 text-body-2-medium text-text-tertiary">No results</p>
          ) : (
            filtered.map((group, groupIndex) => (
              <div key={group.label ?? groupIndex} className="flex flex-col gap-1">
                {group.label ? (
                  <span className="text-mono-label px-2 pt-1 text-text-tertiary">{group.label}</span>
                ) : null}
                {group.options.map((option) => (
                  <DropdownItem
                    key={option.value}
                    selected={option.value === value}
                    onSelect={() => pick(option.value)}
                  >
                    <OptionMark option={option} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={cx(
                          "truncate text-body-2-medium text-text-primary",
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
                  </DropdownItem>
                ))}
              </div>
            ))
          )}
        </div>
      </DropdownPopover>
    </Dropdown>
  );
}
