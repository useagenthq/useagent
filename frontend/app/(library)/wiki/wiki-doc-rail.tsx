"use client";

import { PagesRail } from "./pages-rail";
import type { WikiDoc } from "./wiki-data";
import { ShowOlderWikiPages, useWikiDocPages } from "./wiki-older-pages";

/** The pages rail beside one document: the first page of published documents,
 *  with older pages added on request. */
export function WikiDocRail({
  initialDocs,
  initialNextCursor,
  activeId,
}: {
  initialDocs: WikiDoc[];
  initialNextCursor: string | null;
  activeId: string;
}) {
  const pages = useWikiDocPages(initialDocs, initialNextCursor);
  return (
    <PagesRail docs={pages.docs} activeId={activeId}>
      <ShowOlderWikiPages pages={pages} className="mt-3 flex flex-col items-start gap-2" />
    </PagesRail>
  );
}
