"use client";

import { RiCheckLine, RiFileCopyLine } from "@remixicon/react";
import { useEffect, useRef, useState } from "react";

import { cnExt } from "@/utils/cn";

export interface CopyPillProps {
  /** Command shown in the pill and written to the clipboard on copy. */
  command: string;
  className?: string;
}

/**
 * A full-width install/command pill: monospace command on the left, copy-to-
 * clipboard action on the right that flips to a check for ~1.5s after a copy.
 */
export function CopyPill({ command, className }: CopyPillProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={cnExt(
        "flex w-full items-center gap-3 rounded-xl bg-bg-weak-50 px-4 py-3",
        className,
      )}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-paragraph-sm text-text-strong-950">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy command"}
        className={cnExt(
          "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
          "text-text-sub-600 transition-colors duration-150 ease-out",
          "hover:bg-bg-sub-300 hover:text-text-strong-950",
          "outline-none focus-visible:ring-2 focus-visible:ring-primary-base",
        )}
      >
        {copied ? (
          <RiCheckLine className="size-4 text-success-base" aria-hidden />
        ) : (
          <RiFileCopyLine className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}
