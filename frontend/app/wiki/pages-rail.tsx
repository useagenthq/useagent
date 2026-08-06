import Link from "next/link";

import { cnExt } from "@/utils/cn";
import type { WikiDoc } from "./wiki-data";

/**
 * Left "PAGES" rail: every published document links to its own dedicated page
 * (/wiki/[id]); the current one is highlighted. Replaces the old scroll-anchor
 * table of contents - with 100+ imported documents, one giant concatenated
 * page was unreadable (user report).
 */
export function PagesRail({
  docs,
  activeId,
}: {
  docs: WikiDoc[];
  activeId?: string;
}) {
  if (docs.length === 0) return null;
  return (
    <nav
      aria-label="Wiki pages"
      className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-8rem)] lg:w-64 lg:shrink-0 lg:overflow-y-auto"
    >
      <p className="text-mono-label text-text-soft-400">Pages</p>
      <ul className="mt-2 space-y-0.5">
        {docs.map((doc) => (
          <li key={doc.id}>
            <Link
              href={`/wiki/${doc.id}`}
              className={cnExt(
                "block truncate rounded-lg px-2.5 py-1.5 text-label-sm transition-colors",
                doc.id === activeId
                  ? "bg-bg-weak-50 text-text-strong-950"
                  : "text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950",
              )}
              title={doc.title}
            >
              {doc.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
