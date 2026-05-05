"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import * as SegmentedControl from "@/components/ui/segmented-control";

/**
 * Light/Dark segmented toggle for the settings General card, wired to
 * next-themes (`.dark` class on <html>). Guarded behind a mount flag so the
 * control doesn't hydrate against an unknown theme.
 */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const current = (theme === "system" ? resolvedTheme : theme) ?? "light";

  return (
    <SegmentedControl.Root
      value={mounted ? current : "light"}
      onValueChange={setTheme}
    >
      <SegmentedControl.List aria-label="Theme" className="w-[152px]">
        <SegmentedControl.Trigger value="light">Light</SegmentedControl.Trigger>
        <SegmentedControl.Trigger value="dark">Dark</SegmentedControl.Trigger>
      </SegmentedControl.List>
    </SegmentedControl.Root>
  );
}
