import { RiBookOpenLine, RiFileList3Line } from "@remixicon/react";
import type { Metadata } from "next";
import Link from "next/link";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";
import * as Badge from "@/components/ui/badge";
import { AskRepoBar } from "./ask-repo-bar";
import { PagesRail } from "./pages-rail";
import { wikiContentPreview } from "./wiki-content-data";
import { fetchPublishedWikiDocuments, relativeTime, type WikiDoc } from "./wiki-data";

export const metadata: Metadata = {
  title: "Wiki",
  description: "Published knowledge documents for your organization.",
};

// The Wiki is a VIEW over published knowledge documents (mem_op.md 0.3): it lists
// and renders the org's published documents from the same store the agent searches
// — no static content, no separate wiki database. Server-rendered; an empty/errored
// fetch shows an honest empty state rather than stale hardcoded pages.
export default async function WikiPage() {
  let docs: WikiDoc[] = [];
  let failed = false;
  try {
    docs = await fetchPublishedWikiDocuments();
  } catch {
    // backend unreachable — render the distinct error state below (NOT the
    // empty state; an outage must never look like "no pages yet")
    failed = true;
  }

  return (
    <AppShell sidebar={<LibrarySidebar active="wiki" />}>
      <div className="mx-auto w-full max-w-5xl p-6 pb-24 lg:p-8 lg:pb-24">
        {/* Header */}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-stroke-soft-200 bg-bg-weak-50">
              <RiBookOpenLine className="size-5 text-text-sub-600" aria-hidden />
            </span>
            <div>
              <h1 className="text-display-md text-text-strong-950">Wiki</h1>
              <p className="mt-0.5 text-paragraph-sm text-text-soft-400">
                Published knowledge documents · your organization
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Badge.Root variant="lighter" size="medium" color={failed ? "orange" : "gray"}>
                  <Badge.Icon as={RiFileList3Line} />
                  {failed ? "unavailable" : `${docs.length} published`}
                </Badge.Root>
              </div>
            </div>
          </div>
        </header>

        {/* Body: pages rail + INDEX cards. Each document has a dedicated page
            (/wiki/[id]) - concatenating 100+ full documents onto one scroll was
            unreadable (user report). */}
        <div className="mt-8 flex flex-col gap-8 lg:flex-row lg:gap-10">
          <PagesRail docs={docs} />

          <article className="min-w-0 flex-1">
            {failed ? (
              <BackendUnreachable />
            ) : docs.length === 0 ? (
              <div className="rounded-2xl border border-stroke-soft-200 bg-bg-weak-50 p-10 text-center">
                <RiFileList3Line className="mx-auto size-7 text-text-soft-400" aria-hidden />
                <p className="mt-3 text-label-md text-text-strong-950">No published pages yet</p>
                <p className="mx-auto mt-1 max-w-md text-paragraph-sm leading-6 text-text-sub-600">
                  Publish a knowledge document and it appears here — the same content the agent can
                  search. Create one from Knowledge, then publish its revision.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {docs.map((doc) => {
                  const preview = wikiContentPreview(doc.content, doc.title);

                  return (
                    <li key={doc.id}>
                      <Link
                        href={`/wiki/${doc.id}`}
                        className="border-stroke-soft-200 bg-bg-white-0 hover:bg-bg-weak-50 block rounded-xl border px-4 py-3 transition-colors"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-label-md text-text-strong-950 truncate">
                            {doc.title}
                          </span>
                          <span className="text-paragraph-xs text-text-soft-400 shrink-0">
                            updated {relativeTime(doc.updatedAt)}
                          </span>
                        </div>
                        {preview && (
                          <p className="text-paragraph-sm text-text-sub-600 mt-1 line-clamp-2">
                            {preview}
                          </p>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            <AskRepoBar />
          </article>
        </div>
      </div>
    </AppShell>
  );
}
