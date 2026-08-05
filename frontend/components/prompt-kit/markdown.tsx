// Vendored from prompt-kit (prompt-kit.com/c/markdown.json), adapted to the
// AlignUI foundation: `cn` → `cnExt` and the inline-code token
// (`bg-primary-foreground`) → AlignUI `bg-bg-weak-50`. Block-splitting +
// per-block memoization keep re-renders cheap while text streams in.

import { cnExt as cn } from "@/utils/cn";
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
          className={cn(
            "bg-bg-weak-50 text-text-strong-950 ring-stroke-soft-200 rounded-md px-1.5 py-0.5 font-mono text-[0.85em] ring-1 ring-inset",
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
      <div className="border-stroke-soft-200 my-3 w-full overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-paragraph-sm [&_tbody_tr:last-child]:border-b-0">
          {children}
        </table>
      </div>
    );
  },
  thead: function TheadComponent({ children }) {
    return <thead className="bg-bg-weak-50">{children}</thead>;
  },
  tr: function TrComponent({ children }) {
    return (
      <tr className="border-stroke-soft-200 border-b">{children}</tr>
    );
  },
  th: function ThComponent({ children }) {
    return (
      <th className="text-text-sub-600 text-label-xs px-3 py-2 text-left align-top font-medium">
        {children}
      </th>
    );
  },
  td: function TdComponent({ children }) {
    return (
      <td className="text-text-strong-950 px-3 py-2 align-top">{children}</td>
    );
  },
  blockquote: function BlockquoteComponent({ children }) {
    return (
      <blockquote className="border-stroke-soft-200 text-text-sub-600 my-3 border-l-2 pl-3">
        {children}
      </blockquote>
    );
  },
  hr: function HrComponent() {
    return <hr className="border-stroke-soft-200 my-4" />;
  },
};

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
    <div className={className}>
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
