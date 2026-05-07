"use client";

import { useEffect, useState } from "react";

import { cnExt } from "@/utils/cn";

export interface TocSection {
  id: string;
  label: string;
}

/**
 * In-content "On this page" rail. Sticky within the scrollable main region,
 * with a scroll-spy active state driven by an IntersectionObserver keyed on the
 * article's section headings. Sections are the PUBLISHED wiki documents, passed
 * from the server page (mem_op.md 0.3 — the Wiki is a view over published
 * knowledge, not a static catalogue).
 */
export function TableOfContents({ sections }: { sections: TocSection[] }) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");

  useEffect(() => {
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-96px 0px -66% 0px", threshold: 0 },
    );

    for (const section of sections) {
      const el = document.getElementById(section.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections]);

  if (sections.length === 0) return null;

  return (
    <nav aria-label="On this page" className="hidden w-[220px] shrink-0 lg:block">
      <div className="sticky top-6">
        <p className="text-mono-label px-3 pb-2 text-text-soft-400">Pages</p>
        <ul className="space-y-0.5">
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                onClick={() => setActive(section.id)}
                aria-current={active === section.id ? "location" : undefined}
                className={cnExt(
                  "block rounded-lg px-3 py-1.5 text-label-sm transition-colors",
                  active === section.id
                    ? "bg-bg-weak-50 text-text-strong-950"
                    : "text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950",
                )}
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
