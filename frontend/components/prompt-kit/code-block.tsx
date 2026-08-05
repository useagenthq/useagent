"use client";

// Vendored from prompt-kit (prompt-kit.com/c/code-block.json), adapted to the
// AlignUI foundation: `cn` → `cnExt` (clsx + tailwind-merge) and shadcn tokens
// (border/bg-card) → AlignUI semantic tokens. Shiki highlights on the client;
// an un-highlighted <pre> is the SSR/first-paint fallback.

import { cnExt as cn } from "@/utils/cn";
import React, { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

export type CodeBlockProps = {
  children?: React.ReactNode;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div
      className={cn(
        "not-prose flex w-full flex-col overflow-clip border",
        "border-stroke-soft-200 bg-bg-weak-50 text-text-strong-950 rounded-xl",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type CodeBlockCodeProps = {
  code: string;
  language?: string;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlockCode({
  code,
  language = "tsx",
  className,
  ...props
}: CodeBlockCodeProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function highlight() {
      if (!code) {
        setHighlightedHtml("<pre><code></code></pre>");
        return;
      }
      try {
        // Dual theme: light tokens by default, `--shiki-dark` tokens activated
        // under `.dark` (see the `.dark .shiki` rule in globals.css). The warm
        // dark surface (#20201f ladder) made github-light's navy strings
        // illegible; github-dark-default reads cleanly on it.
        const html = await codeToHtml(code, {
          lang: language,
          themes: { light: "github-light", dark: "github-dark-default" },
          defaultColor: "light",
        });
        if (!cancelled) setHighlightedHtml(html);
      } catch {
        // Unknown grammar/theme — fall back to the plain <pre> below.
        if (!cancelled) setHighlightedHtml(null);
      }
    }
    highlight();
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const classNames = cn(
    "w-full overflow-x-auto text-[13px] [&>pre]:px-4 [&>pre]:py-4 [&>pre]:!bg-transparent",
    className,
  );

  return highlightedHtml ? (
    <div
      className={classNames}
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      {...props}
    />
  ) : (
    <div className={classNames} {...props}>
      <pre className="font-mono">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>;

function CodeBlockGroup({ children, className, ...props }: CodeBlockGroupProps) {
  return (
    <div
      className={cn("flex items-center justify-between", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock };
