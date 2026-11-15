"use client";

import { RiBookOpenLine, RiFileList3Line } from "@remixicon/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Chip } from "@/components/base/badges/chip";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { relativeTime } from "@/utils/format";
import { PagesRail } from "./pages-rail";
import type { WikiDoc } from "./wiki-data";
import { ShowOlderWikiPages, useWikiDocPages } from "./wiki-older-pages";

/** The Wiki index: the published documents loaded so far, as the pages rail
 *  and the index cards, with older pages added on request. `children` follow
 *  the cards. */
export function WikiIndex({
  initialDocs,
  initialNextCursor,
  failed,
  children,
}: {
  initialDocs: WikiDoc[];
  /** Cursor for the documents past the server-rendered page; null when it held them all. */
  initialNextCursor: string | null;
  failed: boolean;
  children?: ReactNode;
}) {
  const pages = useWikiDocPages(initialDocs, initialNextCursor);
  const { docs } = pages;

  return (
    <>
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
                {failed ? "unavailable" : `${docs.length}${pages.nextCursor ? "+" : ""} published`}
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
                Publish a knowledge document and it appears here, the same content the agent can
                search. Create one from Knowledge, then publish its revision.
              </p>
            </div>
          ) : (
            <>
              <ul className="space-y-2">
                {docs.map((doc) => (
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
                      {doc.excerpt && (
                        <p className="text-body-2-regular text-text-secondary mt-1 line-clamp-2">
                          {doc.excerpt}
                        </p>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
              <ShowOlderWikiPages pages={pages} className="mt-6 flex flex-col items-center gap-2" />
            </>
          )}

          {children}
        </article>
      </div>
    </>
  );
}
