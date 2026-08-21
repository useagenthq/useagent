import { RiArrowLeftLine } from "@remixicon/react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";
import { AskRepoBar } from "../ask-repo-bar";
import { PagesRail } from "../pages-rail";
import { WikiContent } from "../wiki-content";
import { fetchPublishedWikiDocuments, relativeTime, type WikiDoc } from "../wiki-data";

export const metadata: Metadata = {
  title: "Wiki",
  description: "A published knowledge document.",
};

/** Dedicated page per published document; the rail lists siblings for
 *  navigation. Content is the same store the agent searches. */
export default async function WikiDocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let docs: WikiDoc[] = [];
  let failed = false;
  try {
    docs = await fetchPublishedWikiDocuments();
  } catch {
    failed = true;
  }
  const doc = docs.find((d) => d.id === id);
  if (!failed && !doc) notFound();

  return (
    <AppShell sidebar={<LibrarySidebar active="wiki" />}>
      <div className="mx-auto w-full max-w-6xl p-6 pb-24 lg:p-8 lg:pb-24">
        <Link
          href="/wiki"
          className="text-label-sm text-text-sub-600 hover:text-text-strong-950 inline-flex items-center gap-1.5 transition-colors"
        >
          <RiArrowLeftLine className="size-4" aria-hidden />
          All pages
        </Link>

        <div className="mt-6 flex flex-col gap-8 lg:flex-row lg:gap-10">
          <PagesRail docs={docs} activeId={id} />

          <article className="min-w-0 flex-1">
            {failed ? (
              <BackendUnreachable />
            ) : doc ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <h1 className="text-title-h5 text-text-strong-950">{doc.title}</h1>
                  <span className="text-paragraph-xs text-text-soft-400 shrink-0">
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
    </AppShell>
  );
}
