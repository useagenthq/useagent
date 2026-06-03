// Vendored from prompt-kit (prompt-kit.com/c/markdown.json), adapted to the
// foundation: `cn` → `cnExt` and the inline-code token
// (`bg-primary-foreground`) → `bg-background-secondary-default`. Block-splitting +
// per-block memoization keep re-renders cheap while text streams in.

import { cx } from "@/utils/cx";
import { marked } from "marked";
import { memo, useId, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/ai/code-block";

export type MarkdownProps = {
  children: string;
  id?: string;
  className?: string;
  components?: Partial<Components>;
};

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown);
  return tokens.map((token) => token.raw);
}

function extractLanguage(className?: string): string {
  if (!className) return "plaintext";
  const match = className.match(/language-(\w+)/);
  return match ? match[1] : "plaintext";
}

const INITIAL_COMPONENTS: Partial<Components> = {
  code: function CodeComponent({ className, children, ...props }) {
    const isInline =
      !props.node?.position?.start.line ||
      props.node?.position?.start.line === props.node?.position?.end.line;

    if (isInline) {
      // Inline chip: a hairline-ringed pill on the weak surface, sized just under
      // the surrounding 13px rhythm so code reads as an accent, not a jump.
      return (
        <span
          className={cx(
            "bg-background-secondary-default text-text-primary ring-border-button-default rounded-md px-1.5 py-0.5 font-mono text-[0.85em] ring-1 ring-inset",
            className,
          )}
          {...props}
        >
          {children}
        </span>
      );
    }

    const language = extractLanguage(className);

    // `my-3` gives fenced blocks the same vertical breathing room as paragraphs
    // (the CodeBlock card carries no margin of its own).
    return (
      <CodeBlock
        className="my-3"
        code={String(children ?? "").replace(/\n$/, "")}
        language={language}
      />
    );
  },
  pre: function PreComponent({ children }) {
    return <>{children}</>;
  },
  // Tables: wrap in a horizontally-scrollable hairline card so wide tables never
  // cram the column; header on the weak surface, rows split by soft hairlines.
  table: function TableComponent({ children }) {
    return (
      <div className="border-border-button-default my-3 w-full overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-body-2-regular [&_tbody_tr:last-child]:border-b-0">
          {children}
        </table>
      </div>
    );
  },
  thead: function TheadComponent({ children }) {
    return <thead className="bg-background-secondary-default">{children}</thead>;
  },
  tr: function TrComponent({ children }) {
    return (
      <tr className="border-border-button-default border-b">{children}</tr>
    );
  },
  th: function ThComponent({ children }) {
    return (
      <th className="text-text-secondary text-caption-1-medium px-3 py-2 text-left align-top">
        {children}
      </th>
    );
  },
  td: function TdComponent({ children }) {
    return (
      <td className="text-text-primary px-3 py-2 align-top">{children}</td>
    );
  },
  blockquote: function BlockquoteComponent({ children }) {
    return (
      <blockquote className="border-border-button-default text-text-secondary my-3 border-l-2 pl-3">
        {children}
      </blockquote>
    );
  },
  hr: function HrComponent() {
    return <hr className="border-border-button-default my-4" />;
  },
};

// Flow-element prose styling shared by EVERY Markdown consumer. The
// foundation ships no @tailwindcss/typography, and Tailwind preflight strips
// list markers - so lists, headings, paragraphs and links are mapped to brand
// tokens HERE, once. Callers may still extend/override via className (cnExt
// merges with caller classes winning). Historically this lived only in the
// conversation surface, which left every other consumer with bulletless lists.
const FLOW_CLASS = cx(
  // First/last block flush to the container's edges; even rhythm elsewhere.
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_p]:my-2",
  // BoardUI scale: paragraphs/lists carry no size of their own - they inherit
  // the consumer's scale (the chat timeline passes text-body-2-regular), so
  // prose children never fall back to the 16px browser default. Headings sit
  // ONE step above the surrounding body copy (13px body -> 14px h1/h2),
  // differentiated by weight below that, not by size jumps.
  "[&_h1]:text-body-semibold [&_h1]:mt-4 [&_h1]:mb-1.5",
  "[&_h2]:text-body-medium [&_h2]:mt-4 [&_h2]:mb-1.5",
  "[&_h3]:text-body-2-semibold [&_h3]:mt-3 [&_h3]:mb-1",
  "[&_h4]:text-caption-1-medium [&_h4]:mt-3 [&_h4]:mb-1",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
  "[&_a]:text-blue-500 [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-medium",
);

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    components = INITIAL_COMPONENTS,
  }: {
    content: string;
    components?: Partial<Components>;
  }) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    );
  },
  function propsAreEqual(prevProps, nextProps) {
    return prevProps.content === nextProps.content;
  },
);

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock";

function MarkdownComponent({
  children,
  id,
  className,
  components = INITIAL_COMPONENTS,
}: MarkdownProps) {
  const generatedId = useId();
  const blockId = id ?? generatedId;
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children]);

  return (
    <div className={cx(FLOW_CLASS, className)}>
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          key={`${blockId}-block-${index}`}
          content={block}
          components={components}
        />
      ))}
    </div>
  );
}

const Markdown = memo(MarkdownComponent);
Markdown.displayName = "Markdown";

export { Markdown };
