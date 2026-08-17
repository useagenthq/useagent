"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { RiArrowDownSLine } from "@remixicon/react";

import { ThemeMenu, THEME_OPTIONS, ThemeSwatch } from "@/components/shell/theme-menu";

/**
 * Theme picker for the Settings General card: a labeled dropdown trigger
 * (swatch + current theme name) wired to next-themes (theme class on <html>).
 * Guarded behind a mount flag so the label doesn't render against an unknown
 * theme; defaults to Midnight, matching the app's default theme.
 */
export function ThemeToggle() {
  const { theme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const active = THEME_OPTIONS.find((o) => o.value === theme) ?? THEME_OPTIONS[1];

  return (
    <ThemeMenu align="end">
      <button
        type="button"
        aria-label="Theme"
        className="flex w-[152px] items-center gap-2 rounded-lg bg-bg-white-0 px-3 py-2 text-left text-label-sm text-text-strong-950 outline-none ring-1 ring-inset ring-stroke-soft-200 transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
      >
        <ThemeSwatch swatch={active.swatch} />
        <span className="flex-1 truncate">{mounted ? active.label : "Theme"}</span>
        <RiArrowDownSLine className="size-4 shrink-0 text-text-soft-400" aria-hidden />
      </button>
    </ThemeMenu>
  );
}
