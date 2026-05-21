"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/chat/MessageCopyButton.tsx (the copy
// affordance on a settled assistant message: small outline icon button,
// copy -> brief check state, "Copy to clipboard" tooltip).
//
// Port notes:
// - lucide CopyIcon/CheckIcon -> @remixicon/react RiFileCopyLine/RiCheckLine.
// - Their useCopyToClipboard hook + anchoredToastManager "Copied!" toast -> a
//   local copied flag on navigator.clipboard.writeText with the same 1s reset;
//   a copy failure simply leaves the idle icon (no toast system here).
// - Their shadcn Button + base-ui Tooltip -> a plain tokened button + the
//   AlignUI tooltip (provider already mounted in app/providers.tsx). The
//   size/variant props are dropped - one fixed size serves this surface.
// - Upstream's aria-label "Copy link" is a misnomer; ours says "Copy message".

import { RiCheckLine, RiFileCopyLine } from "@remixicon/react";
import { memo, useEffect, useRef, useState } from "react";
import * as Tooltip from "@/components/ui/tooltip";

const COPIED_RESET_MS = 1000;

/** Copies the settled answer markdown to the clipboard with a brief check state. */
export const MessageCopyButton = memo(function MessageCopyButton({
  text,
}: {
  /** The answer markdown, copied verbatim. */
  text: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // nothing was copied - keep the idle icon
    }
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          data-session-ui="message-copy-button"
          aria-label="Copy message"
          disabled={copied}
          onClick={() => void copy()}
          className="flex size-6 items-center justify-center rounded-md border border-stroke-soft-200 text-text-sub-600 outline-none transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
        >
          {copied ? (
            <RiCheckLine className="size-3 text-success-base" />
          ) : (
            <RiFileCopyLine className="size-3" />
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content size="xsmall">Copy to clipboard</Tooltip.Content>
    </Tooltip.Root>
  );
});
