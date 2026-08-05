"use client";

import { useState } from "react";
import { RiCloseLine } from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";
import * as Button from "@/components/ui/button";

export interface ApprovalOption {
  label: string;
  detail?: string;
}

export interface ApprovalCardProps {
  question: string;
  options: ApprovalOption[];
  onApprove: (option: ApprovalOption) => void;
  onDeny: () => void;
  /** Adds a free-text "Type something…" row that overrides the radio choice. */
  allowCustom?: boolean;
  className?: string;
}

/**
 * Richer approval prompt: radio-select option rows, an optional custom-answer
 * field, and a deny / approve footer. Approve stays disabled until a choice is
 * made. Ported from the beautiful-ui ApprovalCard demo onto AlignUI tokens +
 * the AlignUI Button.
 */
export function ApprovalCard({
  question,
  options,
  onApprove,
  onDeny,
  allowCustom = false,
  className,
}: ApprovalCardProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const [custom, setCustom] = useState("");

  const customActive = allowCustom && custom.trim().length > 0;
  const canApprove = selected !== null || customActive;

  function approve() {
    if (customActive) {
      onApprove({ label: custom.trim() });
      return;
    }
    if (selected !== null) onApprove(options[selected]);
  }

  return (
    <div
      className={cn(
        "animate-ai-fade-up w-full overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-md",
        className,
      )}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <span className="text-label-md text-text-strong-950">{question}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDeny}
            className="flex size-6 shrink-0 items-center justify-center rounded-lg text-text-soft-400 transition-colors duration-100 hover:bg-bg-soft-200 hover:text-text-sub-600"
          >
            <RiCloseLine className="size-4" aria-hidden />
          </button>
        </div>

        <div className="mt-3 flex flex-col gap-0.5">
          {options.map((option, index) => {
            const active = selected === index && !customActive;
            return (
              <button
                key={option.label}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setSelected(index);
                  setCustom("");
                }}
                className="-mx-1.5 flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-bg-weak-50"
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full transition-colors duration-200",
                    active
                      ? "bg-primary-base"
                      : "ring-1 ring-inset ring-stroke-sub-300",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full bg-static-white transition-transform duration-200",
                      active ? "scale-100" : "scale-0",
                    )}
                  />
                </span>
                <span className="min-w-0">
                  <span
                    className={cn(
                      "block text-label-sm transition-colors duration-200",
                      active ? "text-text-strong-950" : "text-text-sub-600",
                    )}
                  >
                    {option.label}
                  </span>
                  {option.detail && (
                    <span className="block text-paragraph-xs text-text-soft-400">
                      {option.detail}
                    </span>
                  )}
                </span>
              </button>
            );
          })}

          {allowCustom && (
            <label className="-mx-1.5 flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors duration-100 focus-within:bg-bg-weak-50 hover:bg-bg-weak-50">
              <span aria-hidden className="size-4 shrink-0" />
              <input
                value={custom}
                onChange={(event) => {
                  setCustom(event.target.value);
                  setSelected(null);
                }}
                placeholder="Type something…"
                aria-label="Custom answer"
                className="min-w-0 flex-1 bg-transparent text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
              />
            </label>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-stroke-soft-200 bg-bg-weak-50 px-4 py-3">
        <Button.Root className="rounded-full" variant="neutral" mode="stroke" size="small" onClick={onDeny}>
          Deny
        </Button.Root>
        <Button.Root className="rounded-full"
          variant="primary"
          mode="filled"
          size="small"
          disabled={!canApprove}
          onClick={approve}
        >
          Approve
        </Button.Root>
      </div>
    </div>
  );
}
