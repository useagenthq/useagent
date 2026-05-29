"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "@/utils/cx";

/**
 * Sticky left section rail for the settings page. Anchor links jump to each
 * section; a scroll-spy (IntersectionObserver against the top band of the
 * scroll region) keeps the matching link marked active as the page scrolls.
 */

export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "usage", label: "Usage" },
  { id: "machine", label: "Machine" },
  { id: "secrets", label: "Secrets" },
  { id: "providers", label: "Providers" },
  { id: "team", label: "Team" },
] as const;

export function SettingsRail() {
  const [active, setActive] = useState<string>(SETTINGS_SECTIONS[0].id);
  const visible = useRef(new Map<string, boolean>());

  useEffect(() => {
    const els = SETTINGS_SECTIONS.map(({ id }) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    if (els.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visible.current.set(entry.target.id, entry.isIntersecting);
        }
        const firstVisible = SETTINGS_SECTIONS.find(({ id }) => visible.current.get(id));
        if (firstVisible) setActive(firstVisible.id);
      },
      // Active zone is the top ~30% of the viewport so a section lights up as
      // its heading nears the top rather than only when fully in view.
      { rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );

    els.forEach((el) => {
      observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
      {SETTINGS_SECTIONS.map(({ id, label }) => {
        const selected = active === id;
        return (
          <a
            key={id}
            href={`#${id}`}
            aria-current={selected ? "true" : undefined}
            className={cx(
              "rounded-2lg px-3 py-1.5 text-body-2-medium transition-colors duration-150",
              "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
              selected
                ? "bg-linear-to-b from-accent-500 to-accent-600 text-white shadow-nav-selected"
                : "text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary",
            )}
          >
            {label}
          </a>
        );
      })}
    </nav>
  );
}
