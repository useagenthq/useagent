import { RiArrowLeftLine } from "@remixicon/react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { AskRepoBar } from "../ask-repo-bar";
import { WikiContent } from "../wiki-content";
import {
  fetchPublishedWikiDocument,
  fetchPublishedWikiDocuments,
  type WikiDocDetail,
  type WikiDocListPage,
} from "../wiki-data";
import { WikiDocRail } from "../wiki-doc-rail";
import { relativeTime } from "@/utils/format";

export const metadata: Metadata = {
  title: "Wiki",
  description: "A published knowledge document.",
};

/** Dedicated page per published document, read directly so one past the first
 *  list page opens too; the rail lists siblings for navigation. Content is the
 *  same store the agent searches. */
export default async function WikiDocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [docResult, railResult] = await Promise.allSettled([
    fetchPublishedWikiDocument(id),
    fetchPublishedWikiDocuments(),
  ]);
  const failed = docResult.status === "rejected";
  const doc: WikiDocDetail | null = docResult.status === "fulfilled" ? docResult.value : null;
  if (!failed && !doc) notFound();
  // The rail is navigation only: when its list fails, the document still shows.
  const rail: WikiDocListPage =
    railResult.status === "fulfilled" ? railResult.value : { docs: [], nextCursor: null };

  return (
    <div className="mx-auto w-full max-w-6xl p-6 pb-24 lg:p-8 lg:pb-24">
        <Link
          href="/wiki"
          className="text-body-2-medium text-text-secondary hover:text-text-primary inline-flex items-center gap-1.5 transition-colors"
        >
          <RiArrowLeftLine className="size-4" aria-hidden />
          All pages
        </Link>

        <div className="mt-6 flex flex-col gap-8 lg:flex-row lg:gap-10">
          <WikiDocRail initialDocs={rail.docs} initialNextCursor={rail.nextCursor} activeId={id} />

          <article className="min-w-0 flex-1">
            {failed ? (
              <BackendUnreachable />
            ) : doc ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <h1 className="text-title-2-medium text-text-primary">{doc.title}</h1>
                  <span className="text-caption-1-regular text-text-tertiary shrink-0">
                    updated {relativeTime(doc.updatedAt)}
                  </span>
                </div>
                <WikiContent content={doc.content} />
              </>
            ) : null}

            <AskRepoBar />
          </article>
        </div>
      </div>
  );
}
