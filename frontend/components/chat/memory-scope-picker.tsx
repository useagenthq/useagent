"use client";

import { useState } from "react";
import {
  RiArrowDownSLine,
  RiCheckLine,
  RiTeamLine,
  RiUser3Line,
} from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";
import type { MemoryScope } from "@/components/chat/types";

/** The two memory scopes, with the copy + icon each surfaces in the picker. */
const SCOPES: {
  value: MemoryScope;
  label: string;
  hint: string;
  icon: typeof RiTeamLine;
}[] = [
  {
    value: "org",
    label: "Organization memory",
    hint: "Shared team memory - every member recalls it",
    icon: RiTeamLine,
  },
  {
    value: "personal",
    label: "Personal memory",
    hint: "Your private memory, plus organization memory",
    icon: RiUser3Line,
  },
];

/** Short trigger labels (the compact composer has little room). */
const TRIGGER_LABEL: Record<MemoryScope, string> = {
  org: "Org memory",
  personal: "Personal memory",
};

/**
 * Compact popover selector for a run's team-memory scope, sibling to the model
 * picker on both composers. "Organization memory" reads + captures the shared
 * team pool; "Personal memory" reads the actor's private pool AND org memory,
 * capturing only to personal. The active scope is always shown on the trigger.
 * Anatomy mirrors ModelPicker so the two controls read identically.
 */
export function MemoryScopePicker({
  scope,
  onChange,
  className,
}: {
  scope: MemoryScope;
  onChange: (scope: MemoryScope) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const active = SCOPES.find((s) => s.value === scope) ?? SCOPES[0];
  const ActiveIcon = active.icon;

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Memory scope: ${active.label}`}
        className="text-text-strong-950 hover:bg-bg-weak-50 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-label-sm transition-colors"
      >
        <ActiveIcon className="text-text-sub-600 size-4" aria-hidden />
        <span>{TRIGGER_LABEL[active.value]}</span>
        <RiArrowDownSLine className="text-text-soft-400 size-4" aria-hidden />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" aria-hidden onClick={() => setOpen(false)} />
          <div className="border-stroke-soft-200 bg-bg-white-0 shadow-regular-md absolute bottom-11 right-0 z-20 w-64 rounded-2xl border p-1.5">
            <p className="text-mono-label text-text-soft-400 px-2 pb-1 pt-1.5">Memory</p>
            {SCOPES.map((s) => {
              const selected = s.value === scope;
              const Icon = s.icon;
              return (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => {
                    onChange(s.value);
                    setOpen(false);
                  }}
                  className="hover:bg-bg-weak-50 flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left transition-colors"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center",
                      selected ? "text-primary-base" : "text-transparent",
                    )}
                  >
                    <RiCheckLine className="size-4" aria-hidden />
                  </span>
                  <Icon className="text-text-sub-600 mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="text-label-sm text-text-strong-950 block">{s.label}</span>
                    <span className="text-paragraph-xs text-text-soft-400 block">{s.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
