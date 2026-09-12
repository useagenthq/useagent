"use client";

import { RiErrorWarningLine } from "@remixicon/react";
import type { ReactNode } from "react";

/** The composer's one-line alert row above the card: a failed send, a notice
 *  about the last accepted send, or a failed Stop. Same glyph and tone for all
 *  three so the slot reads as one thing. */
export function ComposerAlert({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="text-text-error-primary mb-1.5 flex items-center gap-1.5 px-1 text-caption-1-regular"
    >
      <RiErrorWarningLine className="size-3.5 shrink-0" aria-hidden />
      {children}
    </div>
  );
}
