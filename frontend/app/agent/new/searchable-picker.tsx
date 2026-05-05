"use client";

import { useMemo, useState, type ComponentType } from "react";
import { RiArrowDownSLine, RiCheckLine, RiSearchLine } from "@remixicon/react";
import * as Popover from "@/components/ui/popover";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import { cnExt } from "@/utils/cn";

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
}

function OptionMark({ option }: { option: PickerOption }) {
  if (option.markTint) {
    return <AsteriskMark className={cnExt("size-4 shrink-0", option.markTint)} />;
  }
  if (option.icon) {
    const Icon = option.icon;
    return <Icon className="size-[18px] shrink-0 text-text-sub-600" aria-hidden />;
  }
  return null;
}

/**
 * Cursor-style picker: an AlignUI Popover whose panel opens with a search input
 * at the top, then sectioned groups (a "Recents" group first) of selectable
 * rows with a checkmark on the active one. The trigger reflects the current
 * selection (its mark/icon + label), matching the composer's other controls.
 */
export function SearchablePicker({
  ariaLabel,
  triggerLabel,
  searchPlaceholder,
  groups,
  value,
  onChange,
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
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="inline-flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-label-sm text-text-strong-950 outline-none transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
        >
          {selected ? <OptionMark option={selected} /> : null}
          <span className={cnExt("truncate", selected?.mono && "font-mono text-paragraph-xs")}>
            {selected?.label ?? triggerLabel}
          </span>
          <RiArrowDownSLine className="size-4 shrink-0 text-text-sub-600" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Content
        unstyled
        showArrow={false}
        align="start"
        sideOffset={6}
        className="w-[264px] overflow-hidden rounded-2xl bg-bg-white-0 p-2.5 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200"
      >
        <div className="-mx-2.5 -mt-2.5 mb-1 flex items-center gap-2 border-b border-stroke-soft-200 px-3 pb-2 pt-1">
          <RiSearchLine className="size-4 shrink-0 text-text-soft-400" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-label-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
          />
        </div>
        <div className="flex max-h-[264px] flex-col gap-1.5 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-2 py-2 text-label-sm text-text-soft-400">No results</p>
          ) : (
            filtered.map((group, groupIndex) => (
              <div key={group.label ?? groupIndex} className="flex flex-col gap-1">
                {group.label ? (
                  <span className="text-mono-label px-2 pt-1 text-text-soft-400">{group.label}</span>
                ) : null}
                {group.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => pick(option.value)}
                    className="flex items-center gap-2 rounded-lg p-2 text-left outline-none transition-colors hover:bg-bg-weak-50 focus-visible:bg-bg-weak-50"
                  >
                    <OptionMark option={option} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={cnExt(
                          "truncate text-label-sm text-text-strong-950",
                          option.mono && "font-mono text-paragraph-xs",
                        )}
                      >
                        {option.label}
                      </span>
                      {option.caption ? (
                        <span className="truncate text-paragraph-xs text-text-soft-400">
                          {option.caption}
                        </span>
                      ) : null}
                    </span>
                    {option.value === value ? (
                      <RiCheckLine className="size-4 shrink-0 text-text-sub-600" aria-hidden />
                    ) : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
