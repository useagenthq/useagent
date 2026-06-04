"use client";

// Suggested next questions under a settled answer (beautiful-ui "Streaming
// Text" follow-ups grammar): a muted caption + full-width bordered rows with a
// branch glyph. Picking one hands the text to the composer; the component only
// renders what it is given, it never generates suggestions.

import { RiCornerDownRightLine } from "@remixicon/react";

export function FollowUpRows({
  suggestions,
  onPick,
}: {
  suggestions: readonly string[];
  onPick: (suggestion: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-1.5" data-testid="follow-up-rows">
      <span className="text-caption-1-medium text-text-tertiary">Follow-ups</span>
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => onPick(suggestion)}
          className="flex w-full items-center gap-2 rounded-lg border border-border-button-default px-3 py-1.5 text-left text-body-2-regular text-text-secondary outline-none transition-colors hover:bg-background-primary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <RiCornerDownRightLine
            className="size-3.5 shrink-0 text-foreground-icon-tertiary"
            aria-hidden
          />
          <span className="min-w-0 truncate">{suggestion}</span>
        </button>
      ))}
    </div>
  );
}
