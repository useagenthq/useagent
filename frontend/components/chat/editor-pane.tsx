"use client";

import { useEffect, useMemo, useState } from "react";
import { cx as cn } from "@/utils/cx";
import { CodeBlock } from "@/components/ai/code-block";
import { FileKindBadge, fileTypeIcon } from "@/components/chat/tool-step-row";
import { parseFileEntries, type ApiStep, type FileEntry } from "@/components/chat/types";

/** Collapse every file step into a de-duplicated list of touched files, latest
 * change kind winning, ordered by first appearance. */
function filesFromSteps(steps: ApiStep[]): FileEntry[] {
  const byPath = new Map<string, FileEntry>();
  for (const step of steps) {
    if (step.kind !== "file") continue;
    for (const entry of parseFileEntries(step)) {
      const existing = byPath.get(entry.path);
      // Keep original insertion order; refresh the change kind + latest content.
      byPath.set(
        entry.path,
        existing
          ? { ...existing, kind: entry.kind, content: entry.content ?? existing.content }
          : entry,
      );
    }
  }
  return [...byPath.values()];
}

/**
 * The top pane of the editor|terminal split: a tab strip of every file the run
 * actually touched (real basenames), over an honest detail view. File bodies
 * aren't captured over the wire yet, so the view shows the real path + change
 * kind rather than fabricated source — no synthesized code.
 */
export function EditorPane({ steps, live }: { steps: ApiStep[]; live: boolean }) {
  const files = useMemo(() => filesFromSteps(steps), [steps]);
  const [active, setActive] = useState<string | null>(null);

  // Follow the newest file as it arrives; keep the user's pick otherwise.
  useEffect(() => {
    if (files.length === 0) return;
    setActive((cur) =>
      cur && files.some((f) => f.path === cur)
        ? cur
        : files[files.length - 1].path,
    );
  }, [files]);

  const current = files.find((f) => f.path === active) ?? files[files.length - 1];

  return (
    <div className="bg-background-primary-default flex h-full min-h-0 flex-col overflow-hidden" data-testid="editor-pane">
      {/* File tab strip */}
      <div className="border-border-button-default flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1.5">
        {files.length === 0 ? (
          <span className="text-mono-label text-text-tertiary px-2.5 py-2.5">
            Editor
          </span>
        ) : (
          files.map((file) => {
            const isActive = file.path === current?.path;
            const Icon = fileTypeIcon(file.base);
            return (
              <button
                key={file.path}
                type="button"
                onClick={() => setActive(file.path)}
                title={file.path}
                data-testid="editor-file"
                className={cn(
                  "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-caption-1-medium transition-colors",
                  isActive
                    ? "border-blue-500 text-text-primary"
                    : "border-transparent text-text-tertiary hover:text-text-secondary",
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                {file.base}
              </button>
            );
          })
        )}
      </div>

      {/* Detail surface */}
      <div className="min-h-0 flex-1 overflow-auto">
        {current ? (
          <FileDetail entry={current} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-body-2-regular text-text-tertiary">
              {live ? "Waiting for the first file edit…" : "No files were edited."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const EXT_LANG: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  json: "json", css: "css", scss: "scss", html: "html", md: "md", mdx: "md",
  py: "python", rs: "rust", go: "go", sh: "bash", yml: "yaml", yaml: "yaml", sql: "sql",
};

function langForFile(base: string): string {
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "plaintext";
}

/**
 * The current file's detail: a meta strip (change kind + full path) over the
 * beautiful-ui CodeBlock surface. Renders the real body when the engine mirrored
 * it, otherwise an honest placeholder — never fabricated source.
 */
function FileDetail({ entry }: { entry: FileEntry }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border-button-default flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <FileKindBadge kind={entry.kind} />
        <span
          className="text-text-secondary min-w-0 flex-1 truncate font-mono text-caption-1-medium"
          title={entry.path}
        >
          {entry.path}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <CodeBlock
          filename={entry.base}
          language={langForFile(entry.base)}
          code={entry.content ?? ""}
          emptyLabel="Content capture lands with the engine event mirror."
        />
      </div>
    </div>
  );
}
