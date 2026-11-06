"use client";

// Renders a ```mermaid fenced block as a diagram. The mermaid library is
// heavy, so it is imported lazily inside the effect: pages and messages
// without a mermaid block never pay for it. Until a render succeeds (still
// loading, still streaming in, or a diagram that does not parse) the plain
// code block stands in, which is also the failure fallback the issue asks
// for: a broken diagram shows its source, never an error.

import { useEffect, useId, useState } from "react";
import { CodeBlock, CopyButton } from "@/components/ai/code-block";
import { cx } from "@/utils/cx";

/** Mermaid's built-in palettes, named for the app theme they pair with. */
export function mermaidThemeName(isDark: boolean): "dark" | "default" {
  return isDark ? "dark" : "default";
}

/** Dark-scheme themes: the `html.dark, html.dusk, ...` list in app/globals.css. */
const DARK_THEMES = ["dark", "dusk", "aura", "harbor", "phosphor", "slate", "ember", "sakura-night"];
const isDarkRoot = (root: Element) => DARK_THEMES.some((theme) => root.classList.contains(theme));

/** The app theme lives on the <html> class list (next-themes); follow it so
 *  a diagram re-renders when the user flips between light and dark. */
function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState<boolean>(
    () => typeof document !== "undefined" && isDarkRoot(document.documentElement),
  );
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setIsDark(isDarkRoot(root));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

export function MermaidDiagram({ code, className }: { code: string; className?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const isDark = useIsDarkTheme();
  const instanceId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const diagramId = `mermaid-diagram-${instanceId}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: mermaidThemeName(isDark),
        });
        const rendered = await mermaid.render(diagramId, code);
        if (!cancelled) setSvg(rendered.svg);
      } catch {
        // Unparseable source (a half-streamed block, a typo): fall back to
        // the code block below. suppressErrorRendering keeps mermaid from
        // drawing its error graphic and removes its temporary nodes.
        if (!cancelled) setSvg(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, isDark, diagramId]);

  if (!svg) {
    return <CodeBlock className={className} code={code} language="mermaid" />;
  }

  return (
    <div
      className={cx(
        "not-prose border-border-button-default bg-background-secondary-default shadow-card flex w-full flex-col overflow-hidden rounded-2xl border",
        className,
      )}
    >
      <div className="border-border-button-default bg-background-primary-default flex h-11 items-center justify-between border-b px-4">
        <span className="text-text-tertiary text-caption-1-medium">Mermaid</span>
        <CopyButton code={code} />
      </div>
      <div
        className="overflow-x-auto px-4 py-4 [&>svg]:mx-auto [&>svg]:h-auto [&>svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
