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
  const parentTitle = parent?.title ?? "Parent session";
  return (
    <>
      <Link
        href={`/session/${relationship.parentThreadId}`}
        className="text-text-secondary hover:text-text-primary flex min-w-0 items-center gap-1 text-caption-1-medium transition-colors"
        aria-label={`Back to ${parentTitle}`}
      >
        <RiArrowLeftLine className="size-4 shrink-0" aria-hidden />
        <span className="max-w-48 truncate">{parentTitle}</span>
      </Link>
      <span aria-hidden className="text-text-tertiary">/</span>
      <span className="max-w-48 truncate text-caption-1-medium text-text-primary">
        {relationship.title}
      </span>
    </>
  );
}
