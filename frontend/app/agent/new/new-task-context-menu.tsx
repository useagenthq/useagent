"use client";

import {
  RiAddLine,
  RiAttachment2,
  RiBookMarkedLine,
  RiCheckLine,
  RiSearchLine,
} from "@remixicon/react";
import { useMemo, useState } from "react";
import {
  Dropdown,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { cx } from "@/utils/cx";
import type { PickerGroup, PickerOption } from "./searchable-picker";

interface NewTaskContextMenuProps {
  readonly skillGroups: PickerGroup[];
  readonly selectedSkill: string;
  readonly onAddFiles: () => void;
  readonly onSelectSkill: (skillId: string) => void;
}

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
    <Dropdown
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <DropdownTrigger
        aria-label="Add files and context"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-foreground-icon-secondary outline-none transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiAddLine
          className={cx("size-5 transition-transform duration-200", open && "rotate-45")}
          aria-hidden
        />
      </DropdownTrigger>
      <DropdownPopover
        aria-label="Add files and context"
        placement="bottom start"
        offset={8}
        className="w-[520px] p-2"
      >
        <DropdownItem
          className="gap-3 rounded-xl px-2.5"
          onSelect={() => {
            setOpen(false);
            onAddFiles();
          }}
        >
          <RiAttachment2 className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
          <span className="text-body-2-medium text-text-primary">Add photos &amp; files</span>
          <span className="truncate text-body-2-regular text-text-tertiary">
            Upload from computer
          </span>
        </DropdownItem>

        <div className="max-h-[320px] overflow-y-auto py-1">
          {visibleGroups.length > 0 ? (
            visibleGroups.map((group, groupIndex) => (
              <div key={group.label ?? groupIndex} className="flex flex-col gap-1 py-1">
                {group.label ? (
                  <p className="px-2.5 pb-1 pt-1 text-mono-label text-text-tertiary">
                    {group.label}
                  </p>
                ) : null}
                {group.options.map((option) => {
                  const Icon = option.icon ?? RiBookMarkedLine;
                  return (
                    <DropdownItem
                      key={option.value || "none"}
                      className="gap-3 rounded-xl px-2.5"
                      onSelect={() => selectSkill(option)}
                    >
                      <Icon className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-2-medium text-text-primary">
                          {option.label}
                        </span>
                        {option.caption ? (
                          <span className="block truncate text-caption-1-regular text-text-tertiary">
                            {option.caption}
                          </span>
                        ) : null}
                      </span>
                      {option.value === selectedSkill ? (
                        <RiCheckLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
                      ) : null}
                    </DropdownItem>
                  );
                })}
              </div>
            ))
          ) : (
            <p className="px-2.5 py-2 text-body-2-regular text-text-tertiary">No matching skills</p>
          )}
        </div>

        <label className="mt-1 flex items-center gap-2 border-t border-border-button-default px-2.5 pb-1 pt-3">
          <RiSearchLine className="size-[18px] shrink-0 text-foreground-icon-tertiary" aria-hidden />
          <span className="sr-only">Search skills and playbooks</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type to search skills and playbooks"
            className="min-w-0 flex-1 bg-transparent text-body-2-regular text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </label>
      </DropdownPopover>
    </Dropdown>
  );
}
