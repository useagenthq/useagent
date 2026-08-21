"use client";

import { Markdown } from "@/components/prompt-kit/markdown";
import { cnExt as cn } from "@/utils/cn";
import { wikiContentSegments } from "./wiki-content-data";

export function WikiContent({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const segments = wikiContentSegments(content);
  if (segments.length === 0) return null;

  return (
    <div className={cn("text-paragraph-md text-text-sub-600 mt-4 leading-7", className)}>
      {segments.map((segment, index) =>
        segment.kind === "source-files" ? (
          <details
            key={`source-files-${index}`}
            className="border-stroke-soft-200 bg-bg-weak-50 my-4 rounded-xl border px-4 py-3"
          >
            <summary className="text-label-sm text-text-strong-950 cursor-pointer outline-none marker:text-text-soft-400">
              Relevant source files
            </summary>
            <Markdown className="mt-3 text-paragraph-sm leading-6">{segment.content}</Markdown>
          </details>
        ) : (
          <Markdown key={`markdown-${index}`}>{segment.content}</Markdown>
        ),
      )}
    </div>
  );
}
