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
    <div className={cn("text-paragraph-md text-text-secondary mt-4 leading-7", className)}>
      {segments.map((segment, index) =>
        segment.kind === "source-files" ? (
          <details
            key={`source-files-${index}`}
            className="border-border-button-default bg-background-secondary-default my-4 rounded-xl border px-4 py-3"
          >
            <summary className="text-body-2-medium text-text-primary cursor-pointer outline-none marker:text-text-tertiary">
              Relevant source files
            </summary>
            <Markdown className="mt-3 text-body-2-regular leading-6">{segment.content}</Markdown>
          </details>
        ) : (
          <Markdown key={`markdown-${index}`}>{segment.content}</Markdown>
        ),
      )}
    </div>
  );
}
