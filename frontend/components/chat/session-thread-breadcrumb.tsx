import { RiArrowLeftLine } from "@remixicon/react";
import type { ThreadRelationship } from "@useagent/agent-client";
import Link from "next/link";

export function SessionThreadBreadcrumb({
  relationship,
  parent,
}: {
  readonly relationship: ThreadRelationship | null;
  readonly parent: ThreadRelationship | null;
}) {
  if (!relationship?.parentThreadId) {
    return <span className="text-mono-label text-text-tertiary">Session</span>;
  }
  // Two truncated titles read as near-duplicates ("@bot/Nova compare..." /
  // "Nova: @bot/Nova compare..."), so the parent crumb is a fixed word carrying
  // the full title in its tooltip, and the current crumb is the bot's name when
  // this is a bot's thread.
  const parentTitle = parent?.title ?? "Parent thread";
  return (
    <>
      <Link
        href={`/session/${relationship.parentThreadId}`}
        className="text-text-secondary hover:text-text-primary -my-1 flex min-h-6 min-w-0 items-center gap-1 rounded py-1 text-caption-1-medium transition-colors"
        aria-label={`Back to ${parentTitle}`}
        title={parentTitle}
      >
        <RiArrowLeftLine className="size-4 shrink-0" aria-hidden />
        <span className="truncate">Parent thread</span>
      </Link>
      <span aria-hidden className="text-text-tertiary">/</span>
      <span className="max-w-48 truncate text-caption-1-medium text-text-primary" title={relationship.title}>
        {relationship.bot?.name ?? relationship.title}
      </span>
    </>
  );
}
