"use client";

import { useEffect, useRef } from "react";

import {
  TERMINAL_FONT_LOAD_TEXT,
  applyDevicePixelRatio,
  gridChanged,
  isIdleTerminalNotice,
  terminalFontFamily,
  terminalFontLoadRequests,
  terminalTheme,
  type TerminalGrid,
} from "@/components/chat/terminal-surface";

/**
 * A real shell into the conversation's LIVE sandbox — **ghostty-web** (Ghostty's
 * VT100 parser compiled to WASM, exposing the xterm.js API) over the backend's
 * WS bridge (`/api/runs/:id/terminal` → sandbox PTY). The user types into the
 * same filesystem the agent works in. Mounted only while the Shell tab is
 * active; the socket and PTY die with unmount.
 *
 * The ~400KB WASM ships INLINED in the ghostty-web bundle as a base64 data URL,
 * so `init()` decodes it in-process — no separate asset to copy into `public/`
 * and no Turbopack path wiring. `init()` is an idempotent singleton, so
 * remounting the Shell tab is cheap.
 *
 * Render-surface choreography (fonts before boot, DPR watching, settled-resize
 * notify, full ANSI palette) follows T3 Code's ghostty surface layer; the pure
 * pieces live in `terminal-surface.ts`.
 */

const TERMINAL_FONT_SIZE = 13;
/** The PTY only hears settled dimensions: notifying every drag step makes the
 * shell reprint its prompt mid-drag, which reads as jitter. */
const RESIZE_NOTIFY_DELAY_MS = 150;

/**
 * Ghostty renders to a `<canvas>`, and a canvas 2D context can't resolve a CSS
 * `var(--font-mono)` inside `ctx.font`. Read the computed value of the app's
 * mono variable (next/font emits a hashed family name) and build the full
 * concrete-name stack around it.
 */
function resolveMonoFont(): string {
  if (typeof window === "undefined") return terminalFontFamily();
  // next/font attaches the variable via a className, so it may live on <body>
  // (or lower) rather than the root element — check both.
  const v =
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
    getComputedStyle(document.body).getPropertyValue("--font-mono").trim();
  return terminalFontFamily(v || undefined);
}

/** The canvas glyph atlas snapshots whatever faces are AVAILABLE at Terminal
 * construction — if the webfont hasn't finished loading, the terminal is stuck
 * measuring and rasterizing the fallback. Block briefly on every style the
 * renderer can request (regular/bold/italic/bold-italic), so bold output
 * doesn't rasterize from a synthesized face either. */
async function ensureTerminalFontsLoaded(family: string): Promise<void> {
  try {
    await Promise.race([
      Promise.all(
        terminalFontLoadRequests(family, TERMINAL_FONT_SIZE).map((request) =>
          document.fonts.load(request, TERMINAL_FONT_LOAD_TEXT),
        ),
      ),
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
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 3000;
    let resizeNotifyTimer: ReturnType<typeof setTimeout> | null = null;
    let refitTimer: ReturnType<typeof setTimeout> | null = null;
    let notifiedGrid: TerminalGrid | null = null;
    let dprMedia: MediaQueryList | null = null;
    let onDprChange: (() => void) | null = null;
    let onFontsLoaded: (() => void) | null = null;
    // Show the "waiting for sandbox" notice ONCE per idle stretch, not on every
    // reconnect cycle (the loop otherwise spams "no live sandbox" / "disconnected"
    // back-to-back). Reset when real PTY output resumes so a later drop re-notifies.
    let waitingShown = false;
    let idleNoticeSeen = false;

    void (async () => {
      const { init, Terminal, FitAddon } = await import("ghostty-web");
      // Decode the inlined WASM (idempotent — a no-op once loaded) and wait for
      // the web fonts so glyph metrics are measured against JetBrains Mono, not
      // a fallback (otherwise the grid misaligns until the font swaps in).
      await init();
      await document.fonts?.ready;
      if (disposed) return;

      // The canvas is a real IDE terminal — it stays dark in both app themes.
      // Match its background to the neutral-950 pane it sits in (opaque `rgb(…)`,
      // which ghostty parses) so there's no seam around the padding; the
      // interior gets the full Tokyo Night ANSI palette to match the chrome.
      const bg = getComputedStyle(host).backgroundColor;
      const background = /^rgb\(/.test(bg) ? bg : "#17181a";

      const fontFamily = resolveMonoFont();
      await ensureTerminalFontsLoaded(fontFamily);
      if (disposed) return;
      // A blinking cursor is motion too: reduced-motion readers get a steady one.
      const reducedMotion =
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      term = new Terminal({
        cursorBlink: !reducedMotion,
        cursorStyle: "block",
        fontSize: TERMINAL_FONT_SIZE,
        fontFamily,
        scrollback: 10000,
        theme: terminalTheme(background),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      term.focus();

      // A face that finishes loading after the initial measurement changes
      // glyph advances; re-measure and refit so the grid matches what renders.
      onFontsLoaded = () => {
        if (disposed || !term) return;
        term.renderer?.remeasureFont();
        fit.fit();
      };
      document.fonts?.addEventListener("loadingdone", onFontsLoaded);

      // ghostty-web samples devicePixelRatio once at construction; browser zoom
      // or a monitor move would leave every glyph blurry at the stale ratio.
      // A resolution media query only fires once for the ratio it was created
      // at, so re-arm it after every change (T3's watcher pattern).
      const watchDevicePixelRatio = () => {
        dprMedia?.removeEventListener("change", handleDprChange);
        dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        dprMedia.addEventListener("change", handleDprChange);
      };
      const handleDprChange = () => {
        if (disposed || !term?.renderer) return;
        applyDevicePixelRatio(term.renderer, window.devicePixelRatio);
        watchDevicePixelRatio();
      };
      onDprChange = handleDprChange;
      watchDevicePixelRatio();

      // Connect with AUTO-RECONNECT: the PTY WS dies when the sandbox
      // auto-stops; when it wakes (next run) nothing re-established the
      // session, so the pane sat on "[disconnected]" until a Shell/Log
      // tab-toggle remounted it (user-reported). Now we retry with backoff
      // for as long as the pane is mounted — a resumed sandbox reattaches
      // by itself.
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const connect = () => {
        if (disposed || !term) return;
        notifiedGrid = { cols: term.cols, rows: term.rows };
        const sock = new WebSocket(
          `${proto}://${location.host}/api/runs/${runId}/terminal?cols=${term.cols}&rows=${term.rows}`,
        );
        ws = sock;
        // `disposed` guards: a buffered message or OUR OWN close event can
        // fire after cleanup disposed the terminal (ui-sweep D1).
        sock.onopen = () => {
          reconnectDelay = 3000;
        };
        sock.onmessage = (e) => {
          if (disposed) return;
          const text = String(e.data);
          // Swallow the backend's repeated idle notices - we show a single calm
          // waiting line (below) instead of letting them spam each reconnect.
          // Covers the "no live sandbox" notice and the older red
          // "[skynet] Sandbox <id> not found" variant from the provider.
          if (isIdleTerminalNotice(text)) {
            idleNoticeSeen = true;
            return;
          }
          idleNoticeSeen = false;
          waitingShown = false; // real output flowing again
          term?.write(text);
        };
        sock.onclose = () => {
          if (disposed) return;
          // One friendly line per idle stretch, not a disconnect message every retry.
          if (!waitingShown) {
            waitingShown = true;
            term?.write(
              idleNoticeSeen
                ? "\r\n\x1b[2m• no active sandbox - send a message to start one…\x1b[0m\r\n"
                : "\r\n\x1b[2m• reconnecting to sandbox…\x1b[0m\r\n",
            );
          }
          reconnectTimer = setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, 15000);
        };
      };
      connect();
      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      // Keep the PTY grid in lockstep with the pane — same {type,cols,rows}
      // contract the backend bridge expects, engine-agnostic. The local grid
      // reflows immediately (fit); the PTY only hears settled dimensions,
      // debounced and de-duplicated so a drag doesn't spam identical resizes.
      term.onResize(({ cols, rows }) => {
        if (!gridChanged(notifiedGrid, { cols, rows })) return;
        if (resizeNotifyTimer !== null) clearTimeout(resizeNotifyTimer);
        resizeNotifyTimer = setTimeout(() => {
          resizeNotifyTimer = null;
          if (disposed || !term) return;
          notifiedGrid = { cols: term.cols, rows: term.rows };
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          }
        }, RESIZE_NOTIFY_DELAY_MS);
      });
      // Refit ONLY on a trailing debounce - never per observer fire. During a
      // rail drag the pane resizes every frame; fitting each fire made every
      // frame pay a full grid reflow + canvas bitmap realloc (and FitAddon
      // drops re-entry within 50ms of the last resize anyway, so mid-drag fits
      // landed in ragged 50-150ms steps while pty bytes formatted for the old
      // cols painted into the new grid). One fit after the burst settles gives
      // a single clean reflow; the 150ms PTY notify above then reprints once
      // against the settled grid. Visual stretch DURING the drag is fine.
      observer = new ResizeObserver(() => {
        if (refitTimer !== null) clearTimeout(refitTimer);
        refitTimer = setTimeout(() => {
          refitTimer = null;
          if (!disposed) fit.fit();
        }, 100);
      });
      observer.observe(host);
    })();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (resizeNotifyTimer) clearTimeout(resizeNotifyTimer);
      if (refitTimer) clearTimeout(refitTimer);
      observer?.disconnect();
      if (dprMedia && onDprChange) dprMedia.removeEventListener("change", onDprChange);
      if (onFontsLoaded) document.fonts?.removeEventListener("loadingdone", onFontsLoaded);
      // Detach handlers BEFORE close/dispose — close() fires onclose
      // synchronously-ish with a disposed terminal otherwise.
      if (ws) {
        ws.onmessage = null;
        ws.onclose = null;
        ws.close();
      }
      term?.dispose();
      term = null;
    };
  }, [runId]);

  // `relative` makes this the positioning context for ghostty's absolutely-
  // positioned hidden input textarea (`position:absolute; left:0; top:0`).
  // Without it the textarea escapes to the nearest positioned ancestor
  // (`<main class="relative">`) and its blinking caret shows at the main
  // column's top-left corner, by the SESSION label.
  return <div ref={hostRef} className="relative h-full min-h-0 w-full bg-neutral-950 px-3.5 py-3 [&_textarea]:opacity-0 [&_textarea]:caret-transparent" />;
}
