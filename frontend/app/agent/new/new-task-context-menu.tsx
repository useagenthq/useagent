"use client";

import {
  RiAddLine,
  RiAttachment2,
  RiBookMarkedLine,
  RiBuilding4Line,
  RiUserLine,
} from "@remixicon/react";
import { useState } from "react";
import type { MemoryScope } from "@/components/chat/types";
import * as Popover from "@/components/ui/popover";
import type { PickerGroup } from "./searchable-picker";
import { SearchablePicker } from "./searchable-picker";

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

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
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
        className="w-[360px] rounded-2xl bg-bg-white-0 p-2 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200"
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

        <div className="flex items-center gap-3 rounded-xl px-2.5 py-1">
          <RiBookMarkedLine className="size-[18px] shrink-0 text-text-sub-600" aria-hidden />
          <div className="min-w-0 flex-1 [&>button]:w-full [&>button]:justify-start [&>button]:px-0">
            <SearchablePicker
              ariaLabel="Select skill or playbook"
              triggerLabel="Skill or playbook"
              searchPlaceholder="Search skills and playbooks..."
              groups={skillGroups}
              value={selectedSkill}
              onChange={(skillId) => {
                onSelectSkill(skillId);
                setOpen(false);
              }}
            />
          </div>
        </div>

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

        <p className="px-2.5 pb-1 pt-2 text-paragraph-xs text-text-soft-400">
          Search files, skills, playbooks, and memory context
        </p>
      </Popover.Content>
    </Popover.Root>
  );
}
