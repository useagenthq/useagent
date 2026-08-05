"use client";

import { useEffect, useRef } from "react";

/**
 * A real shell into the conversation's LIVE sandbox — **ghostty-web** (Ghostty's
 * VT100 parser compiled to WASM, exposing the xterm.js API) over the backend's
 * WS bridge (`/api/runs/:id/terminal` → Daytona PTY). The user types into the
 * same filesystem the agent works in. Mounted only while the Shell tab is
 * active; the socket and PTY die with unmount.
 *
 * The ~400KB WASM ships INLINED in the ghostty-web bundle as a base64 data URL,
 * so `init()` decodes it in-process — no separate asset to copy into `public/`
 * and no Turbopack path wiring. `init()` is an idempotent singleton, so
 * remounting the Shell tab is cheap.
 */

/**
 * Ghostty renders to a `<canvas>`, and a canvas 2D context can't resolve a CSS
 * `var(--font-mono)` inside `ctx.font`. Read the computed value of the app's
 * mono variable (next/font emits a hashed family name) and fall back to a
 * JetBrains Mono stack when it's unavailable (SSR / not yet applied).
 */
function resolveMonoFont(): string {
  const fallback = '"JetBrains Mono", ui-monospace, monospace';
  if (typeof window === "undefined") return fallback;
  // next/font attaches the variable via a className, so it may live on <body>
  // (or lower) rather than the root element — check both.
  const v =
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
    getComputedStyle(document.body).getPropertyValue("--font-mono").trim();
  return v ? `${v}, ui-monospace, monospace` : fallback;
}

/** The canvas glyph atlas snapshots whatever font is AVAILABLE at Terminal
 * construction — if the webfont hasn't finished loading, the terminal is stuck
 * rasterizing the Courier fallback. Block briefly on the real face. */
async function ensureMonoLoaded(family: string): Promise<void> {
  try {
    const first = family.split(",")[0]!.trim().replace(/^"|"$/g, "");
    await Promise.race([
      document.fonts.load(`13px "${first}"`),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch {
    /* fonts API unavailable — render with whatever is loaded */
  }
}

export function InteractiveTerminal({ runId }: { runId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: import("ghostty-web").Terminal | null = null;
    let observer: ResizeObserver | null = null;

    void (async () => {
      const { init, Terminal, FitAddon } = await import("ghostty-web");
      // Decode the inlined WASM (idempotent — a no-op once loaded) and wait for
      // the web font so glyph metrics are measured against JetBrains Mono, not
      // a fallback (otherwise the grid misaligns until the font swaps in).
      await init();
      await document.fonts?.ready;
      if (disposed) return;

      // The canvas is a real IDE terminal — it stays dark in both app themes.
      // Match its background to the neutral-950 pane it sits in (opaque `rgb(…)`,
      // which ghostty parses) so there's no seam around the padding; tune the
      // cursor/selection and leave the ANSI palette to ghostty's defaults.
      const bg = getComputedStyle(host).backgroundColor;
      const background = /^rgb\(/.test(bg) ? bg : "#17181a";

      const fontFamily = resolveMonoFont();
      await ensureMonoLoaded(fontFamily);
      if (disposed) return;
      term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily,
        scrollback: 5000,
        theme: {
          background,
          foreground: "#e6e4e0",
          cursor: "#e6e4e0",
          cursorAccent: background,
          selectionBackground: "#45443f",
          selectionForeground: "#ffffff",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      term.focus();

      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(
        `${proto}://${location.host}/api/runs/${runId}/terminal?cols=${term.cols}&rows=${term.rows}`,
      );
      const sock = ws;
      sock.onmessage = (e) => term?.write(String(e.data));
      sock.onclose = () => term?.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n");
      term.onData((data) => {
        if (sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: "input", data }));
        }
      });

      // Keep the PTY grid in lockstep with the pane — same {type,cols,rows}
      // contract the backend bridge expects, engine-agnostic.
      observer = new ResizeObserver(() => {
        fit.fit();
        if (term && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      });
      observer.observe(host);
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      ws?.close();
      term?.dispose();
    };
  }, [runId]);

  // `relative` makes this the positioning context for ghostty's absolutely-
  // positioned hidden input textarea (`position:absolute; left:0; top:0`).
  // Without it the textarea escapes to the nearest positioned ancestor
  // (`<main class="relative">`) and its blinking caret shows at the main
  // column's top-left corner, by the SESSION label.
  return <div ref={hostRef} className="relative h-full min-h-0 w-full bg-neutral-950 px-3.5 py-3" />;
}
