// Ported from beui.dev registry "code-block" (components/agents/code-block.tsx +
// lib/ease inlined). Re-expressed with our AlignUI tokens + Remixicon. The upstream
// shiki highlighter is dropped in favor of a lightweight token-tinted monospace render
// (our color tokens, no async highlighter dependency). A streaming code panel with a
// filename header, language tag, status pill, line numbers, highlighted lines, and copy.
"use client";

import {
  RiCheckLine,
  RiFileCodeLine,
  RiFileCopyLine,
  RiLoader4Line,
} from "@remixicon/react";
import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cx } from "@/utils/cx";

// -- motion tokens ---------------------------------------------------------
const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } as const;

export type CodeLanguage = "bash" | "diff" | "json" | "text" | "tsx" | "typescript";
export type CodeBlockStatus = "streaming" | "complete";

// -- lightweight syntax tint ----------------------------------------------
// A small keyword/string/comment/number pass tinted with our tokens. This is
// intentionally not a full tokenizer - it reads as code without pulling in a
// heavy highlighter.
const KEYWORDS = new Set([
  "import", "export", "from", "default", "const", "let", "var", "function",
  "return", "if", "else", "for", "while", "class", "extends", "new", "async",
  "await", "type", "interface", "enum", "as", "in", "of", "typeof", "yield",
  "true", "false", "null", "undefined", "void", "this", "super",
]);

interface CodeToken {
  text: string;
  kind: "keyword" | "string" | "comment" | "number" | "plain";
}

function tokenizeLine(line: string, language: CodeLanguage): CodeToken[] {
  if (language === "text") return [{ text: line, kind: "plain" }];

  const trimmed = line.trimStart();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  ) {
    return [{ text: line, kind: "comment" }];
  }

  const tokens: CodeToken[] = [];
  // split on strings, words, and numbers while keeping delimiters
  const pattern = /("[^"]*"|'[^']*'|`[^`]*`|\b\d[\d_.]*\b|\b[A-Za-z_$][\w$]*\b)/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) tokens.push({ text: line.slice(last, start), kind: "plain" });
    const value = match[0];
    if (value.startsWith('"') || value.startsWith("'") || value.startsWith("`")) {
      tokens.push({ text: value, kind: "string" });
    } else if (/^\d/.test(value)) {
      tokens.push({ text: value, kind: "number" });
    } else if (KEYWORDS.has(value)) {
      tokens.push({ text: value, kind: "keyword" });
    } else {
      tokens.push({ text: value, kind: "plain" });
    }
    last = start + value.length;
  }
  if (last < line.length) tokens.push({ text: line.slice(last), kind: "plain" });
  return tokens.length ? tokens : [{ text: line, kind: "plain" }];
}

const TOKEN_CLASS: Record<CodeToken["kind"], string> = {
  keyword: "text-accent-500",
  string: "text-lime-600",
  comment: "text-text-tertiary italic",
  number: "text-yellow-600",
  plain: "text-text-secondary",
};

function CodeLine({ content, language }: { content: string; language: CodeLanguage }) {
  const tokens = useMemo(() => tokenizeLine(content, language), [content, language]);
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} className={TOKEN_CLASS[token.kind]}>
          {token.text}
        </span>
      ))}
    </>
  );
}

// -- CodeBlock primitive ---------------------------------------------------
export interface CodeBlockProps {
  code: string;
  language?: CodeLanguage;
  filename?: ReactNode;
  status?: CodeBlockStatus;
  showLineNumbers?: boolean;
  highlightLines?: number[];
  maxHeight?: number;
  wrap?: boolean;
  copyable?: boolean;
  onCopy?: () => void | Promise<void>;
  className?: string;
}

/** Streaming code panel: filename header, language tag, status pill, line numbers, copy. */
export function CodeBlockPanel({
  code,
  language = "typescript",
  filename,
  status = "complete",
  showLineNumbers = true,
  highlightLines = [],
  maxHeight = 280,
  wrap = false,
  copyable = true,
  onCopy,
  className,
}: CodeBlockProps) {
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const streaming = status === "streaming";
  const highlighted = useMemo(() => new Set(highlightLines), [highlightLines]);
  const lines = useMemo(() => code.split("\n"), [code]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !streaming) return;

    const frame = requestAnimationFrame(() => {
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduce ? "auto" : "smooth" });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy();
    else await navigator.clipboard?.writeText(code);

    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [code, onCopy]);

  return (
    <div
      data-state={status}
      aria-busy={streaming}
      className={cx(
        "w-full overflow-hidden rounded-2xl bg-background-secondary-default text-body-2-regular",
        className,
      )}
    >
      <div className="flex h-10 items-center gap-2.5 px-3">
        <RiFileCodeLine aria-hidden="true" className="size-3.5 shrink-0 text-text-tertiary" />
        {filename ? (
          <span className="min-w-0 truncate font-mono text-caption-1-regular text-text-secondary">
            {filename}
          </span>
        ) : null}
        <span className="text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
          {language}
        </span>
        <span
          className={cx(
            "ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] font-medium",
            streaming ? "text-accent-500" : "text-lime-600",
          )}
        >
          {streaming ? (
            <RiLoader4Line className={cx("size-3", !reduce && "animate-spin")} />
          ) : (
            <RiCheckLine className="size-3" />
          )}
          {streaming ? "Writing" : "Ready"}
        </span>
        {copyable || onCopy ? (
          <motion.button
            type="button"
            aria-label={copied ? "Copied" : "Copy code"}
            title={copied ? "Copied" : "Copy code"}
            onClick={handleCopy}
            whileTap={reduce ? undefined : { scale: 0.9 }}
            transition={SPRING_PRESS}
            className="grid size-7 shrink-0 place-items-center rounded-full text-text-secondary outline-none transition-colors hover:bg-background-primary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            {copied ? (
              <RiCheckLine className="size-3.5" />
            ) : (
              <RiFileCopyLine className="size-3.5" />
            )}
          </motion.button>
        ) : null}
      </div>

      <div
        ref={viewportRef}
        role={streaming ? "log" : undefined}
        aria-live={streaming ? "polite" : undefined}
        className="overflow-auto border-t border-border-button-default py-2 [scrollbar-width:none]"
        style={{ maxHeight }}
      >
        <pre className="m-0 min-w-max font-mono text-caption-1-regular leading-5 text-text-secondary">
          <code>
            {lines.map((content, index) => {
              const lineNumber = index + 1;
              return (
                <span
                  key={lineNumber}
                  className={cx(
                    "grid min-h-5",
                    showLineNumbers ? "grid-cols-[2.75rem_minmax(0,1fr)]" : "grid-cols-1",
                    highlighted.has(lineNumber) && "bg-accent-500/[0.07]",
                  )}
                >
                  {showLineNumbers ? (
                    <span className="select-none pr-3 text-right tabular-nums text-text-tertiary">
                      {lineNumber}
                    </span>
                  ) : null}
                  <span
                    className={cx(
                      "pr-4",
                      showLineNumbers ? "pl-1" : "pl-4",
                      wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
                    )}
                  >
                    {content ? <CodeLine content={content} language={language} /> : " "}
                  </span>
                </span>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}

// -- self-driving streaming demo ------------------------------------------
const DEMO_CODE_LINES = [
  "import { useMemo } from 'react'",
  "",
  "export function useTotals(rows: number[]) {",
  "  return useMemo(() => {",
  "    const sum = rows.reduce((a, b) => a + b, 0)",
  "    return { sum, avg: sum / rows.length }",
  "  }, [rows])",
  "}",
];

const STREAM_MS = 380;
const RESET_MS = 3400;

/** Self-driving demo: streams the source in line by line, settles to Ready, then loops. */
export function CodeBlockDemo() {
  const [count, setCount] = useState(1);

  useEffect(() => {
    if (count < DEMO_CODE_LINES.length) {
      const t = setTimeout(() => setCount((c) => c + 1), STREAM_MS);
      return () => clearTimeout(t);
    }
    const reset = setTimeout(() => setCount(1), RESET_MS);
    return () => clearTimeout(reset);
  }, [count]);

  const status: CodeBlockStatus =
    count >= DEMO_CODE_LINES.length ? "complete" : "streaming";

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="w-full max-w-md">
        <CodeBlockPanel
          code={DEMO_CODE_LINES.slice(0, count).join("\n")}
          language="typescript"
          filename="hooks/use-totals.ts"
          status={status}
          highlightLines={[5]}
        />
      </div>
    </div>
  );
}

export default CodeBlockDemo;
