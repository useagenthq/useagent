import { RiBookOpenLine, RiFileList3Line } from "@remixicon/react";
import type { Metadata } from "next";
import Link from "next/link";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";
import { Chip } from "@/components/base/badges/chip";
import { AskRepoBar } from "./ask-repo-bar";
import { PagesRail } from "./pages-rail";
import { wikiContentPreview } from "./wiki-content-data";
import { fetchPublishedWikiDocuments, type WikiDoc } from "./wiki-data";
import { relativeTime } from "@/utils/format";

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
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border-button-default bg-background-secondary-default">
              <RiBookOpenLine className="size-5 text-text-secondary" aria-hidden />
            </span>
            <div>
              <h1 className="text-display-sm text-text-primary">Wiki</h1>
              <p className="mt-0.5 text-body-2-regular text-text-tertiary">
                Published knowledge documents · your organization
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Chip color={failed ? "orange" : "gray"}>
                  <RiFileList3Line className="size-3.5 shrink-0" aria-hidden />
                  {failed ? "unavailable" : `${docs.length} published`}
                </Chip>
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
              <div className="rounded-2xl border border-border-button-default bg-background-secondary-default p-10 text-center">
                <RiFileList3Line className="mx-auto size-7 text-text-tertiary" aria-hidden />
                <p className="mt-3 text-body-medium text-text-primary">No published pages yet</p>
                <p className="mx-auto mt-1 max-w-md text-body-2-regular leading-6 text-text-secondary">
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
                        className="border-border-button-default bg-background-primary-default hover:bg-background-secondary-default block rounded-xl border px-4 py-3 transition-colors"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-body-medium text-text-primary truncate">
                            {doc.title}
                          </span>
                          <span className="text-caption-1-regular text-text-tertiary shrink-0">
                            updated {relativeTime(doc.updatedAt)}
                          </span>
                        </div>
                        {preview && (
                          <p className="text-body-2-regular text-text-secondary mt-1 line-clamp-2">
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
