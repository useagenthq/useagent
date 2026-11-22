import { RiArrowLeftLine } from "@remixicon/react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { AskRepoBar } from "../ask-repo-bar";
import { PagesRail } from "../pages-rail";
import { WikiContent } from "../wiki-content";
import { fetchPublishedWikiDocuments, type WikiDoc } from "../wiki-data";
import { relativeTime } from "@/utils/format";

export const metadata: Metadata = {
  title: "Wiki - UseAgent",
  description: "A published knowledge document.",
  openGraph: {
    title: "Wiki - UseAgent",
    description: "A published knowledge document.",
    images: [{ url: "/og/18-wiki.png", width: 1600, height: 900, alt: "UseAgent Wiki" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Wiki - UseAgent",
    description: "A published knowledge document.",
    images: ["/og/18-wiki.png"],
  },
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
    <div className="mx-auto w-full max-w-6xl p-6 pb-24 lg:p-8 lg:pb-24">
        <Link
          href="/wiki"
          className="text-body-2-medium text-text-secondary hover:text-text-primary inline-flex items-center gap-1.5 transition-colors"
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
