"use client";

import { RiCheckLine } from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";
import { PixelAvatar } from "@/components/chat/agent-command";

/** One selectable chat model - the honest shape the picker renders, mirrored from
 *  `GET /api/chat/models` plus a UI tint assigned by the caller. */
export type ChatModelOption = {
  value: string;
  label: string;
  description: string;
  color: string;
};

/**
 * The real chat MODEL picker, styled as the "Choose Agent" dropdown card the user
 * liked (mono section label + colored glyph + colored name + muted one-line
 * description, hover highlight). The CONTENT is honest: every row is a model the
 * backend key actually serves (`GET /api/chat/models`), and selecting one sets the
 * model sent to `POST /api/chat`. No placeholder flavor text.
 */
export function ChatModelMenu({
  options,
  value,
  onSelect,
  className,
}: {
  options: ChatModelOption[];
  value: string;
  onSelect: (value: string) => void;
  className?: string;
}) {
  if (options.length === 0) return null;
  return (
    <div
      className={cn(
        "border-stroke-soft-200 bg-bg-white-0 shadow-regular-md w-full rounded-2xl border p-2",
        className,
      )}
    >
      <p className="text-mono-label text-text-soft-400 px-2 pb-1 pt-1.5">Choose model</p>
      {options.map((m) => {
        const selected = m.value === value;
        return (
          <button
            key={m.value}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(m.value);
            }}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors",
              selected ? "bg-bg-weak-50" : "hover:bg-bg-weak-50",
            )}
          >
            <PixelAvatar color={m.color} />
            <span className="text-label-sm shrink-0" style={{ color: m.color }}>
              {m.label}
            </span>
            <span className="text-text-soft-400 truncate text-paragraph-sm">{m.description}</span>
            {selected && (
              <RiCheckLine className="text-text-sub-600 ml-auto size-4 shrink-0" aria-hidden />
            )}
          </button>
        );
      })}
    </div>
  );
}
