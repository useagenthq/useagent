"use client";

import { useEffect, useMemo, useState } from "react";
import { RiCheckLine, RiFileCopyLine } from "@remixicon/react";
import { codeToHtml } from "shiki";
import { cx } from "@/utils/cx";

/**
 * Code surface, beautiful-ui `CodeBlock` chrome mapped to our tokens: a card
 * with a header bar (mono filename + language label + Copy) over a
 * line-numbered, syntax-highlighted body whose lines fade up in a stagger.
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
};

function languageLabel(language: string): string {
  return LANGUAGE_LABEL[language.toLowerCase()] ?? language.toUpperCase();
}

function CopyButton({ code }: { code: string }) {
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
      className="text-text-tertiary hover:bg-background-secondary-hover hover:text-text-primary flex h-6 items-center gap-1 rounded-md px-1.5 text-caption-1-medium transition-colors"
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

  useEffect(() => {
    if (!trimmed) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const out = await codeToHtml(trimmed, {
          lang: language,
          themes: { light: "github-light", dark: "github-dark-default" },
          defaultColor: "light",
          transformers: [
            {
              line(node, line) {
                node.properties.class = `${node.properties.class ?? ""} ai-code-line`.trim();
                node.properties.style = `animation-delay:${(line - 1) * 90}ms`;
              },
            },
          ],
        });
        if (!cancelled) setHtml(out);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trimmed, language]);

  return (
    <div
      className={cx(
        "not-prose border-border-button-default bg-background-secondary-default shadow-card group flex w-full flex-col overflow-hidden rounded-2xl border",
        className,
      )}
    >
      {/* Header bar */}
      <div className="border-border-button-default bg-background-primary-default flex items-center justify-between border-b px-3 py-1.5">
        <span className="flex items-baseline gap-2 truncate">
          {filename && (
            <span className="text-text-primary truncate font-mono text-[12px] font-medium">
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
        <div className="ai-code-surface overflow-x-auto text-[12.5px] leading-[1.7]">
          {html ? (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            // SSR / pre-highlight fallback: plain mono with manual line numbers.
            <pre className="[font-family:var(--font-mono)]">
              <code>
                {trimmed.split("\n").map((ln, i) => (
                  <span key={i} className="ai-code-line line">
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
