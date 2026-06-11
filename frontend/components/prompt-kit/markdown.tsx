// Vendored from prompt-kit (prompt-kit.com/c/markdown.json), adapted to the
// foundation: `cn` → `cnExt` and the inline-code token
// (`bg-primary-foreground`) → `bg-background-secondary-default`. Block-splitting +
// per-block memoization keep re-renders cheap while text streams in.

import { marked } from "marked";
import { memo, useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/ai/code-block";
import { type OpenWorkpiece, useOpenWorkpiece } from "@/components/chat/workspace-open-context";
import { backendFetch } from "@/lib/backend-fetch";
import { cx } from "@/utils/cx";

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

type WorkspaceEligibility = "loading" | "raw" | "workspace";

export function artifactPayloadSupportsWorkspace(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = (value as { artifact?: unknown }).artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false;
  const descriptor = artifact as { workpiece?: unknown; preview_pdf_url?: unknown };
  return (
    (descriptor.workpiece !== null &&
      typeof descriptor.workpiece === "object" &&
      !Array.isArray(descriptor.workpiece)) ||
    (typeof descriptor.preview_pdf_url === "string" && descriptor.preview_pdf_url.length > 0)
  );
}

function ArtifactMarkdownChip({
  url,
  label,
  tone,
  initial,
  openWorkpiece,
}: {
  readonly url: string;
  readonly label: string;
  readonly tone: string;
  readonly initial: string;
  readonly openWorkpiece: OpenWorkpiece;
}) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [eligibility, setEligibility] = useState<WorkspaceEligibility>("loading");
  useEffect(() => setOrigin(window.location.origin), []);
  const previewTarget = useMemo(
    () => (origin ? artifactWorkspaceTarget(url, label, origin) : null),
    [label, origin, url],
  );

  useEffect(() => {
    if (!previewTarget) {
      setEligibility("raw");
      return;
    }
    const controller = new AbortController();
    setEligibility("loading");
    void (async () => {
      try {
        const response = await backendFetch(
          `/api/artifacts/${encodeURIComponent(previewTarget.id)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) {
          setEligibility("raw");
          return;
        }
        setEligibility(
          artifactPayloadSupportsWorkspace(await response.json()) ? "workspace" : "raw",
        );
      } catch {
        if (!controller.signal.aborted) setEligibility("raw");
      }
    })();
    return () => controller.abort();
  }, [previewTarget]);

  const chipClassName =
    "mx-0.5 inline-flex translate-y-[-1px] items-center gap-1.5 rounded-full bg-background-secondary-default py-0.5 pl-1 pr-2 align-middle text-caption-1-medium text-text-primary no-underline transition-colors hover:bg-background-secondary-hover";
  const content = (
    <>
      <span
        aria-hidden
        className={`flex size-4 items-center justify-center rounded-full text-[9px] font-semibold leading-none text-white ${tone}`}
      >
        {initial}
      </span>
      <span className="max-w-56 truncate">{label}</span>
      <span aria-hidden className="text-text-tertiary">
        ↗
      </span>
    </>
  );

  if (previewTarget && eligibility === "workspace") {
    return (
      <button
        type="button"
        data-chip
        onClick={() => openWorkpiece(previewTarget)}
        aria-label={`Open ${previewTarget.name} in workspace`}
        className={chipClassName}
      >
        {content}
      </button>
    );
  }
  if (previewTarget && eligibility === "loading") {
    return (
      <button
        type="button"
        data-chip
        disabled
        aria-busy="true"
        aria-label={`Loading preview for ${previewTarget.name}`}
        className={chipClassName}
      >
        {content}
      </button>
    );
  }
  return (
    <a data-chip href={url} target="_blank" rel="noreferrer" className={chipClassName}>
      {content}
    </a>
  );
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
    return <tr className="border-border-button-default border-b">{children}</tr>;
  },
  th: function ThComponent({ children }) {
    return (
      <th className="text-text-secondary text-caption-1-medium px-3 py-2 text-left align-top">
        {children}
      </th>
    );
  },
  td: function TdComponent({ children }) {
    return <td className="text-text-primary px-3 py-2 align-top">{children}</td>;
  },
  a: function AnchorComponent({ href, children }) {
    const url = typeof href === "string" ? href : "";
    const openWorkpiece = useOpenWorkpiece();
    // Artifact/media links render as dense source chips (type badge + label +
    // arrow), matching the retrieval-chip grammar; ordinary links stay links.
    const isArtifact = /\/(?:api|agent)\/artifacts\//.test(url);
    const ext = (
      url.match(/\.(mp4|webm|pdf|docx|xlsx|pptx|csv|png|jpg|zip)(?:\?|$)/i)?.[1] ?? ""
    ).toUpperCase();
    if (isArtifact || ext) {
      const label =
        typeof children === "string"
          ? children
          : Array.isArray(children)
            ? children.join("")
            : "Open";
      const tone =
        ext === "PDF"
          ? "bg-red-500"
          : ext === "CSV" || ext === "XLSX"
            ? "bg-green-600"
            : ext === "MP4" || ext === "WEBM"
              ? "bg-purple-500"
              : ext === "PPTX"
                ? "bg-orange-500"
                : "bg-blue-500";
      const initial = (label.trim().charAt(0) || "F").toUpperCase();
      if (openWorkpiece) {
        return (
          <ArtifactMarkdownChip
            url={url}
            label={label}
            tone={tone}
            initial={initial}
            openWorkpiece={openWorkpiece}
          />
        );
      }
      return (
        <a
          data-chip
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mx-0.5 inline-flex translate-y-[-1px] items-center gap-1.5 rounded-full bg-background-secondary-default py-0.5 pl-1 pr-2 align-middle text-caption-1-medium text-text-primary no-underline transition-colors hover:bg-background-secondary-hover"
        >
          <span
            aria-hidden
            className={`flex size-4 items-center justify-center rounded-full text-[9px] font-semibold leading-none text-white ${tone}`}
          >
            {initial}
          </span>
          <span className="max-w-56 truncate">{label}</span>
          <span aria-hidden className="text-text-tertiary">
            ↗
          </span>
        </a>
      );
    }
    return (
      <a href={url} target="_blank" rel="noreferrer">
        {children}
      </a>
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

export function artifactWorkspaceTarget(
  value: string,
  label: string,
  origin: string,
): { readonly id: string; readonly name: string } | null {
  if (!/^preview\b/i.test(label.trim())) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, origin);
  } catch {
    return null;
  }
  if (parsed.origin !== origin) return null;
  if (parsed.searchParams.get("download") === "1") return null;
  const pathname = parsed.pathname;
  const match = /^\/(?:api\/artifacts\/([^/]+)\/content|agent\/artifacts\/([^/]+))$/.exec(pathname);
  const encodedId = match?.[1] ?? match?.[2];
  if (!encodedId) return null;
  try {
    const id = decodeURIComponent(encodedId);
    const name =
      label
        .trim()
        .replace(/^preview\s+(?:the\s+)?/i, "")
        .trim() || "Artifact";
    return { id, name };
  } catch {
    return null;
  }
}

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
  "[&_a:not([data-chip])]:text-blue-500 [&_a:not([data-chip])]:underline [&_a:not([data-chip])]:underline-offset-2 [&_strong]:font-medium",
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
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
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
