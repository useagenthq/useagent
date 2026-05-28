"use client";

import {
  RiAddLine,
  RiAttachment2,
  RiBookMarkedLine,
  RiCheckLine,
  RiSearchLine,
} from "@remixicon/react";
import { useMemo, useState } from "react";
import * as Popover from "@/components/ui/popover";
import type { PickerGroup, PickerOption } from "./searchable-picker";

interface NewTaskContextMenuProps {
  readonly skillGroups: PickerGroup[];
  readonly selectedSkill: string;
  readonly onAddFiles: () => void;
  readonly onSelectSkill: (skillId: string) => void;
}

const rowClassName =
  "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none transition-colors hover:bg-bg-weak-50 focus-visible:bg-bg-weak-50";

/** Compact, real-action context menu adapted from the AI-kit knowledge composer. */
export function NewTaskContextMenu({
  skillGroups,
  selectedSkill,
  onAddFiles,
  onSelectSkill,
}: NewTaskContextMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visibleGroups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return skillGroups
      .map((group) => ({
        ...group,
        options: normalized
          ? group.options.filter((option) =>
              [option.label, option.caption]
                .filter(Boolean)
                .some((value) => value?.toLowerCase().includes(normalized) === true),
            )
          : group.options,
      }))
      .filter((group) => group.options.length > 0);
  }, [query, skillGroups]);

  function selectSkill(option: PickerOption) {
    onSelectSkill(option.value);
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
          aria-label="Add files and context"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-text-sub-600 outline-none transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
        >
          <RiAddLine
            className={`size-5 transition-transform duration-200 ${open ? "rotate-45" : ""}`}
            aria-hidden
          />
        </button>
      </Popover.Trigger>
      <Popover.Content
        unstyled
        showArrow={false}
        align="start"
        sideOffset={8}
        className="w-[520px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl bg-bg-white-0 p-2 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200"
      >
        <button
          type="button"
          className={rowClassName}
          onClick={() => {
            setOpen(false);
            onAddFiles();
          }}
        >
          <RiAttachment2 className="size-[18px] shrink-0 text-text-sub-600" aria-hidden />
          <span className="text-label-sm text-text-strong-950">Add photos &amp; files</span>
          <span className="truncate text-paragraph-sm text-text-soft-400">
            Upload from computer
          </span>
        </button>

        <div className="max-h-[320px] overflow-y-auto py-1">
          {visibleGroups.length > 0 ? (
            visibleGroups.map((group, groupIndex) => (
              <div key={group.label ?? groupIndex} className="py-1">
                {group.label ? (
                  <p className="px-2.5 pb-1 pt-1 text-mono-label text-text-soft-400">
                    {group.label}
                  </p>
                ) : null}
                {group.options.map((option) => {
                  const Icon = option.icon ?? RiBookMarkedLine;
                  return (
                    <button
                      key={option.value || "none"}
                      type="button"
                      className={rowClassName}
                      onClick={() => selectSkill(option)}
                    >
                      <Icon className="size-[18px] shrink-0 text-text-sub-600" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-label-sm text-text-strong-950">
                          {option.label}
                        </span>
                        {option.caption ? (
                          <span className="block truncate text-paragraph-xs text-text-soft-400">
                            {option.caption}
                          </span>
                        ) : null}
                      </span>
                      {option.value === selectedSkill ? (
                        <RiCheckLine className="size-4 shrink-0 text-text-sub-600" aria-hidden />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          ) : (
            <p className="px-2.5 py-2 text-paragraph-sm text-text-soft-400">No matching skills</p>
          )}
        </div>

        <label className="mt-1 flex items-center gap-2 border-t border-stroke-soft-200 px-2.5 pb-1 pt-3">
          <RiSearchLine className="size-[18px] shrink-0 text-text-soft-400" aria-hidden />
          <span className="sr-only">Search skills and playbooks</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type to search skills and playbooks"
            className="min-w-0 flex-1 bg-transparent text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
          />
        </label>
      </Popover.Content>
    </Popover.Root>
  );
}
