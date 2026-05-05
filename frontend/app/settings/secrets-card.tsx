"use client";

import { useState } from "react";
import { RiAddLine, RiCheckLine, RiDeleteBinLine, RiFileCopyLine } from "@remixicon/react";
import * as Button from "@/components/ui/button";
import { cnExt } from "@/utils/cn";

/**
 * Persisted-secrets list. Each value stays masked; the copy button writes the
 * key name to the clipboard (real values never reach the client), delete drops
 * the row, and "Add secret" appends a new masked placeholder.
 */

const INITIAL_SECRETS = ["GITHUB_TOKEN", "VERCEL_TOKEN", "OPENAI_API_KEY"];
const MASK = "••••••••";

export function SecretsCard() {
  const [secrets, setSecrets] = useState<string[]>(INITIAL_SECRETS);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
    } catch {
      // Clipboard blocked (permissions / insecure context) — still flash the
      // confirmation so the control feels responsive.
    }
    setCopied(name);
    setTimeout(() => setCopied((current) => (current === name ? null : current)), 1200);
  };

  const remove = (name: string) => setSecrets((list) => list.filter((s) => s !== name));

  const add = () => setSecrets((list) => [...list, `NEW_SECRET_${list.length + 1}`]);

  return (
    <div className="flex flex-col">
      {secrets.map((name) => (
        <div
          key={name}
          className="flex items-center gap-3 border-b border-stroke-soft-200 py-2.5 last:border-b-0"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-label-xs text-text-strong-950">
            {name}
          </span>
          <span className="select-none font-mono text-paragraph-xs text-text-sub-600" aria-hidden>
            {MASK}
          </span>
          <Button.Root
            variant="neutral"
            mode="ghost"
            size="xsmall"
            aria-label={`Copy ${name}`}
            onClick={() => void copy(name)}
            className={cnExt("rounded-full", copied === name && "text-success-base")}
          >
            <Button.Icon as={copied === name ? RiCheckLine : RiFileCopyLine} />
          </Button.Root>
          <Button.Root className="rounded-full"
            variant="neutral"
            mode="ghost"
            size="xsmall"
            aria-label={`Delete ${name}`}
            onClick={() => remove(name)}
          >
            <Button.Icon as={RiDeleteBinLine} />
          </Button.Root>
        </div>
      ))}

      <div className="pt-3">
        <Button.Root className="rounded-full" variant="neutral" mode="ghost" size="xsmall" onClick={add}>
          <Button.Icon as={RiAddLine} />
          Add secret
        </Button.Root>
      </div>
    </div>
  );
}
