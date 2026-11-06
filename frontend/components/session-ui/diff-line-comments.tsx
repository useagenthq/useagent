"use client";

// Line comments on one recorded change of the Diff surface. Click a row, drag
// across a few, or move with the arrow keys (Shift extends) and press Enter;
// the comment is held as a draft in the thread's review (./diff-review.ts).

import { RiDeleteBinLine, RiSendPlaneLine } from "@remixicon/react";
import { type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, useCallback, useRef, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import * as Textarea from "@/components/base/textarea/textarea";
import { cx as cn } from "@/utils/cx";
import { type DiffComment, type DiffCommentDraft, describeLines } from "./diff-review";
import type { DiffLine } from "./file-diff-view";

const TONE_WORD = { add: "Added", del: "Removed", context: "Unchanged", meta: "" } as const;

const commentable = (line: DiffLine | undefined) => line !== undefined && line.tone !== "meta";

function lineLabel(line: DiffLine): string {
  const number = line.newLine ?? line.oldLine;
  return `${TONE_WORD[line.tone]}${number === undefined ? "" : ` line ${number}`}: ${line.text || "blank"}`;
}

/** Inline form under the selection: Ctrl/Cmd+Enter saves, Escape cancels. */
function CommentForm({
  label,
  onSave,
  onCancel,
}: {
  label: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const save = () => {
    if (body.trim()) onSave(body);
  };
  return (
    <div className="space-y-2 border-y border-border-button-default bg-background-primary-default px-3 py-2">
      <Textarea.Root
        simple
        autoFocus
        rows={3}
        value={body}
        placeholder="Leave a comment for the agent"
        aria-label={`Comment on ${label}`}
        className="min-h-16 text-paragraph-xs"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="xs" className="rounded-full px-2" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="xs"
          className="rounded-full px-2"
          disabled={!body.trim()}
          onClick={save}
        >
          Add comment
        </Button>
      </div>
    </div>
  );
}

function SavedComment({ comment, onRemove }: { comment: DiffComment; onRemove: (id: string) => void }) {
  return (
    <div
      data-testid="diff-comment"
      className="flex items-start gap-2 border-y border-border-button-default bg-background-primary-default px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="text-caption-1-regular text-text-tertiary">{describeLines(comment.lines)}</p>
        <p className="whitespace-pre-wrap break-words text-paragraph-xs text-text-primary">
          {comment.body}
        </p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        leadingIcon={RiDeleteBinLine}
        aria-label={`Delete comment on ${describeLines(comment.lines)}`}
        onClick={() => onRemove(comment.id)}
      />
    </div>
  );
}

export function CommentableHunk({
  path,
  hunk,
  lines,
  comments,
  onAdd,
  onRemove,
  renderLine,
}: {
  path: string;
  hunk: number;
  lines: readonly DiffLine[];
  /** This hunk's drafts. */
  comments: readonly DiffComment[];
  onAdd: (draft: DiffCommentDraft) => void;
  onRemove: (id: string) => void;
  renderLine: (line: DiffLine) => ReactNode;
}) {
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const [cursor, setCursor] = useState(() => Math.max(0, lines.findIndex((line) => line.tone !== "meta")));
  const [selection, setSelection] = useState<{ anchor: number; head: number } | null>(null);
  const [composing, setComposing] = useState(false);
  const dragging = useRef(false);

  const start = selection ? Math.min(selection.anchor, selection.head) : -1;
  const end = selection ? Math.max(selection.anchor, selection.head) : -1;
  const selected = selection ? lines.slice(start, end + 1).filter((line) => line.tone !== "meta") : [];
  const covered = new Set(
    comments.flatMap((comment) =>
      Array.from({ length: comment.end - comment.start + 1 }, (_, offset) => comment.start + offset),
    ),
  );

  const focusRow = (index: number) => {
    setCursor(index);
    rows.current[index]?.focus({ preventScroll: false });
  };

  const close = useCallback(() => {
    setComposing(false);
    setSelection(null);
  }, []);

  const step = (from: number, delta: number) => {
    for (let index = from + delta; index >= 0 && index < lines.length; index += delta) {
      if (commentable(lines[index])) return index;
    }
    return from;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (move !== 0) {
      event.preventDefault();
      const next = step(index, move);
      if (event.shiftKey) setSelection((prior) => ({ anchor: prior?.anchor ?? index, head: next }));
      else if (!composing) setSelection(null);
      focusRow(next);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!selection || index < start || index > end) setSelection({ anchor: index, head: index });
      setComposing(true);
    } else if (event.key === "Escape" && selection) {
      event.preventDefault();
      close();
    }
  };

  const onMouseDown = (event: ReactMouseEvent, index: number) => {
    if (event.button !== 0) return;
    // Row dragging selects lines, not text.
    event.preventDefault();
    focusRow(index);
    setSelection((prior) =>
      event.shiftKey && prior ? { anchor: prior.anchor, head: index } : { anchor: index, head: index },
    );
    dragging.current = true;
    document.addEventListener(
      "mouseup",
      () => {
        dragging.current = false;
        setComposing(true);
      },
      { once: true },
    );
  };

  const save = (body: string) => {
    if (selected.length === 0) return;
    onAdd({ path, hunk, start, end, lines: selected, body: body.trim() });
    close();
    rows.current[end]?.focus();
  };

  const commentsByEnd = new Map<number, DiffComment[]>();
  for (const comment of comments) {
    commentsByEnd.set(comment.end, [...(commentsByEnd.get(comment.end) ?? []), comment]);
  }

  return (
    <div
      role="group"
      aria-label={`${path}, change ${hunk + 1}. Use the arrow keys to pick lines, Shift to extend, Enter to comment.`}
      className="py-1"
    >
      {lines.map((line, index) => (
        <div key={index}>
          {commentable(line) ? (
            <div
              ref={(element) => {
                rows.current[index] = element;
              }}
              role="button"
              tabIndex={index === cursor ? 0 : -1}
              aria-pressed={index >= start && index <= end}
              aria-label={lineLabel(line)}
              data-diff-line={index}
              onMouseDown={(event) => onMouseDown(event, index)}
              onMouseEnter={() => {
                if (dragging.current) setSelection((prior) => prior && { anchor: prior.anchor, head: index });
              }}
              onFocus={() => setCursor(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "cursor-pointer border-l-2 border-transparent outline-none hover:bg-background-tertiary-hover/55 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring",
                covered.has(index) && "border-foreground-icon-tertiary",
                index >= start && index <= end && "border-border-focus-ring bg-foreground-icon-primary/10",
              )}
            >
              {renderLine(line)}
            </div>
          ) : (
            <div className="border-l-2 border-transparent">{renderLine(line)}</div>
          )}
          {commentsByEnd.get(index)?.map((comment) => (
            <SavedComment key={comment.id} comment={comment} onRemove={onRemove} />
          ))}
          {composing && index === end && selected.length > 0 && (
            <CommentForm
              label={describeLines(selected)}
              onSave={save}
              onCancel={() => {
                close();
                rows.current[end]?.focus();
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** The review's footer over the diff: count, discard, and send. */
export function ReviewBar({
  comments,
  onSend,
  onDiscard,
}: {
  comments: readonly DiffComment[];
  onSend: () => void;
  onDiscard: () => void;
}) {
  const files = new Set(comments.map((comment) => comment.path)).size;
  return (
    <div
      data-testid="diff-review-bar"
      className="sticky top-0 z-10 flex items-center gap-2 rounded-10 border border-border-button-default bg-background-secondary-default px-3 py-2"
    >
      <p className="min-w-0 flex-1 text-paragraph-xs text-text-secondary" aria-live="polite">
        {comments.length === 1 ? "1 comment" : `${comments.length} comments`} on{" "}
        {files === 1 ? "1 file" : `${files} files`}
      </p>
      <Button variant="secondary" size="xs" className="rounded-full px-2" onClick={onDiscard}>
        Discard
      </Button>
      <Button
        variant="primary"
        size="xs"
        className="rounded-full px-2"
        leadingIcon={RiSendPlaneLine}
        onClick={onSend}
      >
        Send comments
      </Button>
    </div>
  );
}
