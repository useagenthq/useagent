"use client";

import { MotionConfig } from "motion/react";
import { ThemeProvider } from "next-themes";

import { SubagentPane } from "@/components/chat/subagent-pane";
import { DesktopTitlebar } from "@/components/shell/desktop-titlebar";

/**
 * Client-side provider stack. Kept as a leaf so the root layout stays a
 * server component. `next-themes` drives the theme class (`dark` / `aura` /
 * `harbor` / `phosphor` / `slate` / `ember` / `sakura-night` / `light` / `sakura` /
 * `phosphor-light`) on <html>.
 *
 * `SubagentPane` is the single global instance of the subagent viewing pane -
 * a portal-based slide-over any surface can open via `openSubagentPane(runId)`.
 *
 * `MotionConfig reducedMotion="user"` makes every motion/react animation honour the
 * person's reduced-motion setting; the CSS side already does through media queries.
 */
export function Providers({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <ThemeProvider
      nonce={nonce}
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      themes={[
        "light",
        "dark",
        "dusk",
        "aura",
        "harbor",
        "phosphor",
        "phosphor-light",
        "sakura",
        "sakura-night",
        "slate",
        "ember",
        "neobrutal",
      ]}
    >
      <MotionConfig reducedMotion="user">
        <DesktopTitlebar />
        {children}
        <SubagentPane />
      </MotionConfig>
    </ThemeProvider>
  );
}
