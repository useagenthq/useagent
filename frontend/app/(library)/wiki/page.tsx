import type { Metadata } from "next";
import { AskRepoBar } from "./ask-repo-bar";
import { fetchPublishedWikiDocuments, type WikiDocListPage } from "./wiki-data";
import { WikiIndex } from "./wiki-index";

export const metadata: Metadata = {
  title: "Wiki",
  description: "Published knowledge documents for your organization.",
};

// The Wiki is a VIEW over published knowledge documents (mem_op.md 0.3): it lists
// and renders the org's published documents from the same store the agent searches
// — no static content, no separate wiki database. Server-rendered first page of
// excerpts, older pages on request; an errored fetch shows an honest error state
// rather than stale hardcoded pages.
export default async function WikiPage() {
  let page: WikiDocListPage = { docs: [], nextCursor: null };
  let failed = false;
  try {
    page = await fetchPublishedWikiDocuments();
  } catch {
    // backend unreachable — render the distinct error state (NOT the empty
    // state; an outage must never look like "no pages yet")
    failed = true;
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-6 pb-24 lg:p-8 lg:pb-24">
      <WikiIndex initialDocs={page.docs} initialNextCursor={page.nextCursor} failed={failed}>
        <AskRepoBar />
      </WikiIndex>
    </div>
  );
}
