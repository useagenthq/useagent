"use client";

import { useEffect, useMemo, useState } from "react";
import { RiCheckLine, RiFileCopyLine } from "@remixicon/react";
import { cx } from "@/utils/cx";

/** How long a block must stop changing before it is highlighted. */
const HIGHLIGHT_SETTLE_MS = 200;

/**
 * Code surface, beautiful-ui `CodeBlock` chrome mapped to our tokens: a card
 * with a header bar (mono filename + language label + Copy) over a
 * line-numbered, syntax-highlighted body.
 *
 * The visual is beautiful-ui; the highlighting underneath is the vendored shiki
 * dual-theme (github-light / github-dark-default) so tokens stay legible on the
 * #20201f dark ladder — see the `.ai-code-surface` rules in globals.css for the
 * line numbers + `.dark .shiki` token swap.
 *
 * Generalized (the demo's hardcoded LINES array does not come along): pass real
 * `code`. With no `code`, `emptyLabel` renders centered in the body — used by the
 * editor pane while file bodies aren't yet mirrored over the wire.
 */
export interface CodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
  /** Trailing caret while the answer is still streaming in. */
  streaming?: boolean;
  /** Shown centered in the body when `code` is empty. */
  emptyLabel?: string;
  className?: string;
}

const LANGUAGE_LABEL: Record<string, string> = {
  tsx: "TypeScript",
  ts: "TypeScript",
  typescript: "TypeScript",
  jsx: "JavaScript",
  js: "JavaScript",
  javascript: "JavaScript",
  json: "JSON",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  md: "Markdown",
  markdown: "Markdown",
  mermaid: "Mermaid",
  py: "Python",
  python: "Python",
  rs: "Rust",
  go: "Go",
  sh: "Shell",
  bash: "Shell",
  yml: "YAML",
  yaml: "YAML",
  sql: "SQL",
  plaintext: "Text",
  "c++": "C++",
  "c#": "C#",
  "objective-c": "Objective-C",
  "f#": "F#",
};

function languageLabel(language: string): string {
  return LANGUAGE_LABEL[language.toLowerCase()] ?? language.toUpperCase();
}

export function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={() => {
        void navigator.clipboard?.writeText(code).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
      className="text-text-tertiary hover:bg-background-secondary-hover hover:text-text-primary flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-caption-1-medium transition-colors"
    >
      {copied ? (
        <RiCheckLine className="text-lime-600 size-3.5" aria-hidden />
      ) : (
        <RiFileCopyLine className="size-3.5" aria-hidden />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function CodeBlock({
  code,
  language = "tsx",
  filename,
  streaming = false,
  emptyLabel,
  className,
}: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const trimmed = useMemo(() => code.replace(/\n$/, ""), [code]);

  // Highlight only once the code has settled: while a block is still growing
  // (streaming, or edits arriving faster than the settle window) the plain mono
  // fallback stays up, and the highlighter, loaded on first use, runs once at
  // the end instead of once per token.
  useEffect(() => {
    setHtml(null);
    if (!trimmed || streaming) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { codeToHtml } = await import("shiki");
        const out = await codeToHtml(trimmed, {
          lang: language,
          themes: { light: "github-light", dark: "github-dark-default", dusk: "tokyo-night" },
          defaultColor: "light",
        });
        if (!cancelled) setHtml(out);
      } catch {
        if (!cancelled) setHtml(null);
      }
    }, HIGHLIGHT_SETTLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmed, language, streaming]);

  return (
    <div
      className={cx(
        "not-prose border-border-button-default bg-background-secondary-default shadow-card group flex w-full flex-col overflow-hidden rounded-2xl border",
        className,
      )}
    >
      {/* Header bar */}
      <div className="border-border-button-default bg-background-primary-default flex items-center justify-between border-b h-11 px-4">
        <span className="flex items-baseline gap-2 truncate">
          {filename && (
            <span className="text-text-primary truncate font-mono">
              {filename}
            </span>
          )}
          <span className="text-text-tertiary shrink-0 text-caption-1-medium">
            {languageLabel(language)}
          </span>
        </span>
        {trimmed && <CopyButton code={trimmed} />}
      </div>

      {/* Body */}
      {trimmed ? (
        <div className="ai-code-surface overflow-x-auto text-[12.5px] leading-[1.65]">
          {html ? (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            // SSR / pre-highlight fallback: plain mono with manual line numbers.
            <pre className="[font-family:var(--font-mono)]">
              <code>
                {trimmed.split("\n").map((ln, i) => (
                  <span key={i} className="line">
                    {ln || " "}
                    {"\n"}
                  </span>
                ))}
              </code>
            </pre>
          )}
          {streaming && (
            <span
              className="ai-caret ml-3 mb-2 inline-block h-3.5 w-1.5 translate-y-0.5 bg-foreground-icon-primary"
              aria-hidden
            />
          )}
        </div>
      ) : (
        <div className="text-text-tertiary flex min-h-[72px] items-center px-3 py-3 [font-family:var(--font-mono)] text-[12.5px]">
          {emptyLabel ?? "No content."}
        </div>
      )}
    </div>
  );
}
