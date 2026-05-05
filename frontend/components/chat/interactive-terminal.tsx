"use client";

import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

/**
 * A real shell into the conversation's LIVE sandbox — xterm.js over the
 * backend's WS bridge (`/api/runs/:id/terminal` → Daytona PTY). The user types
 * into the same filesystem the agent works in. Mounted only while the Shell
 * tab is active; the socket and PTY die with unmount.
 */
export function InteractiveTerminal({ runId }: { runId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    let observer: ResizeObserver | null = null;

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;

      term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "var(--font-mono), monospace",
        theme: { background: "#0a0a0a" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();

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

  return <div ref={hostRef} className="h-full min-h-0 w-full px-2 py-1" />;
}
