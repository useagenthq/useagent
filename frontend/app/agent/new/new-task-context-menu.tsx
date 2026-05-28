"use client";

import {
  RiAddLine,
  RiAttachment2,
  RiBookMarkedLine,
  RiBuilding4Line,
  RiCheckLine,
  RiSearchLine,
  RiUserLine,
} from "@remixicon/react";
import { useMemo, useState } from "react";
import type { MemoryScope } from "@/components/chat/types";
import * as Popover from "@/components/ui/popover";
import type { PickerGroup, PickerOption } from "./searchable-picker";

interface NewTaskContextMenuProps {
  readonly skillGroups: PickerGroup[];
  readonly selectedSkill: string;
  readonly memoryScope: MemoryScope;
  readonly onAddFiles: () => void;
  readonly onSelectSkill: (skillId: string) => void;
  readonly onSelectMemoryScope: (scope: MemoryScope) => void;
}

const rowClassName =
  "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none transition-colors hover:bg-bg-weak-50 focus-visible:bg-bg-weak-50";

/** Compact, real-action context menu adapted from the AI-kit knowledge composer. */
export function NewTaskContextMenu({
  skillGroups,
  selectedSkill,
  memoryScope,
  onAddFiles,
  onSelectSkill,
  onSelectMemoryScope,
}: NewTaskContextMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const skillOptions = useMemo(() => skillGroups.flatMap((group) => group.options), [skillGroups]);
  const visibleSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matching = normalized
      ? skillOptions.filter((option) =>
          [option.label, option.caption]
            .filter(Boolean)
            .some((value) => value?.toLowerCase().includes(normalized) === true),
        )
      : skillOptions;
    return matching.slice(0, 7);
  }, [query, skillOptions]);

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
          aria-label="Add context"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-text-sub-600 outline-none transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
        >
          <RiAddLine className="size-5" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Content
        unstyled
        showArrow={false}
        align="start"
        sideOffset={8}
        className="w-[560px] max-w-[calc(100vw-32px)] rounded-2xl bg-bg-white-0 p-2 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200"
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

        <button
          type="button"
          className={rowClassName}
          aria-pressed={memoryScope === "org"}
          onClick={() => {
            onSelectMemoryScope("org");
            setOpen(false);
          }}
        >
          <RiBuilding4Line className="size-[18px] shrink-0 text-text-sub-600" aria-hidden />
          <span className="text-label-sm text-text-strong-950">Company knowledge</span>
          <span className="truncate text-paragraph-sm text-text-soft-400">
            Use your organization memory
          </span>
        </button>

        <button
          type="button"
          className={rowClassName}
          aria-pressed={memoryScope === "personal"}
          onClick={() => {
            onSelectMemoryScope("personal");
            setOpen(false);
          }}
        >
          <RiUserLine className="size-[18px] shrink-0 text-text-sub-600" aria-hidden />
          <span className="text-label-sm text-text-strong-950">Personal memory</span>
          <span className="truncate text-paragraph-sm text-text-soft-400">
            Use only your saved context
          </span>
        </button>

        <div className="my-1 h-px bg-stroke-soft-200" />

        <div className="max-h-[280px] overflow-y-auto">
          {visibleSkills.length > 0 ? (
            visibleSkills.map((option) => {
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
            })
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
