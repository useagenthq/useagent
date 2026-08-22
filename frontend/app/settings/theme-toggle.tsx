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
    <ThemeMenu
      triggerAriaLabel="Theme"
      triggerClassName="flex w-[152px] items-center gap-2 rounded-2lg bg-background-primary-default px-3 py-2 text-left text-body-2-medium text-text-primary ring-1 ring-inset ring-border-button-default transition-colors hover:bg-background-primary-hover"
    >
      <ThemeSwatch swatch={active.swatch} />
      <span className="flex-1 truncate">{mounted ? active.label : "Theme"}</span>
      <RiArrowDownSLine className="size-4 shrink-0 text-foreground-icon-tertiary" aria-hidden />
    </ThemeMenu>
  );
}
