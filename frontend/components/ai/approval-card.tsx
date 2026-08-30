"use client";

import { useState } from "react";
import { RiCloseLine } from "@remixicon/react";
import { cx } from "@/utils/cx";
import { Button } from "@/components/base/buttons/button";

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
 * made. Ported from the beautiful-ui ApprovalCard demo onto our tokens +
 * the Button.
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
      className={cx(
        "animate-ai-fade-up w-full overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-md",
        className,
      )}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <span className="text-body-medium text-text-primary">{question}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDeny}
            className="flex size-6 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors duration-100 hover:bg-background-secondary-hover hover:text-text-secondary"
          >
            <RiCloseLine className="size-4" aria-hidden />
          </button>
        </div>

        <div className="mt-2.5 flex flex-col gap-1">
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
                className="-mx-1.5 flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-background-primary-hover"
              >
                <span
                  className={cx(
                    "flex size-4 shrink-0 items-center justify-center rounded-full transition-colors duration-200",
                    active
                      ? "bg-accent-500"
                      : "ring-1 ring-inset ring-border-button-hover",
                  )}
                >
                  <span
                    className={cx(
                      "size-1.5 rounded-full bg-white transition-transform duration-200",
                      active ? "scale-100" : "scale-0",
                    )}
                  />
                </span>
                <span className="min-w-0">
                  <span
                    className={cx(
                      "block text-body-2-regular transition-colors duration-200",
                      active ? "text-text-primary" : "text-text-secondary",
                    )}
                  >
                    {option.label}
                  </span>
                  {option.detail && (
                    <span className="block text-caption-1-regular text-text-tertiary">
                      {option.detail}
                    </span>
                  )}
                </span>
              </button>
            );
          })}

          {allowCustom && (
            <label className="-mx-1.5 flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors duration-100 focus-within:bg-background-primary-hover hover:bg-background-primary-hover">
              <span aria-hidden className="size-4 shrink-0" />
              <input
                value={custom}
                onChange={(event) => {
                  setCustom(event.target.value);
                  setSelected(null);
                }}
                placeholder="Type something…"
                aria-label="Custom answer"
                className="min-w-0 flex-1 bg-transparent text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder"
              />
            </label>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border-button-default bg-background-secondary-default px-4 py-3">
        <Button className="rounded-full" variant="secondary" size="small" onClick={onDeny}>
          Deny
        </Button>
        <Button
          className="rounded-full"
          variant="primary"
          size="small"
          disabled={!canApprove}
          onClick={approve}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}
