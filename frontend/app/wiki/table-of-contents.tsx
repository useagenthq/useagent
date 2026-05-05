"use client";

import { useEffect, useState } from "react";

import { cnExt } from "@/utils/cn";

/** Section anchors shared with the article headings in `page.tsx`. */
const sections = [
  { id: "overview", label: "Overview" },
  { id: "architecture", label: "Architecture" },
  { id: "data-flow", label: "Data flow" },
  { id: "key-modules", label: "Key modules" },
  { id: "conventions", label: "Conventions" },
  { id: "faq", label: "FAQ" },
] as const;

/**
 * The wiki's page catalogue (DeepWiki-style). Only "Overview & architecture"
 * is generated so far — the rest are queued chapters, so they render as
 * non-links until their pages exist.
 */
const catalogue = [
  { label: "Overview & architecture", ready: true },
  { label: "Getting started", ready: false },
  { label: "App shell & navigation", ready: false },
  { label: "AlignUI component kit", ready: false },
  { label: "Agent runs & traces", ready: false },
  { label: "Theming & tokens", ready: false },
  { label: "Deployment", ready: false },
] as const;

/**
 * In-content "On this page" rail. Sticky within the scrollable main region,
 * with a scroll-spy active state driven by an IntersectionObserver keyed on
 * the article's section headings.
 */
export function TableOfContents() {
  const [active, setActive] = useState<string>(sections[0].id);

  useEffect(() => {
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
  }, []);

  return (
    <nav aria-label="On this page" className="hidden w-[220px] shrink-0 lg:block">
      <div className="sticky top-6">
        <p className="text-mono-label px-3 pb-2 text-text-soft-400">Pages</p>
        <ul className="space-y-0.5">
          {catalogue.map(({ label, ready }) => (
            <li key={label}>
              {ready ? (
                <a
                  href="#overview"
                  className="block rounded-lg bg-bg-weak-50 px-3 py-1.5 text-label-sm text-text-strong-950"
                >
                  {label}
                </a>
              ) : (
                <span className="block cursor-default rounded-lg px-3 py-1.5 text-label-sm text-text-disabled-300">
                  {label}
                </span>
              )}
            </li>
          ))}
        </ul>

        <p className="text-mono-label px-3 pb-2 pt-6 text-text-soft-400">
          On this page
        </p>
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
