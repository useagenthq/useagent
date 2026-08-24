import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { getRunForOrg } from "./repo";
import { resolvePreviewSandbox } from "./preview-proxy";
import { errorMessage } from "../util/error-message";

// ---------------------------------------------------------------------------
// Interactive terminal — a WebSocket bridge from the browser's xterm.js into
// the LIVE sandbox backing a conversation. Browser ⇄ (this WS) ⇄ Daytona PTY
// (sandbox.process.createPty, itself a WS to the sandbox). The user types into
// the same filesystem their agent works in; nothing here touches the run/event
// log. One PTY per WS connection, killed on disconnect.
// ---------------------------------------------------------------------------

interface PtyLike {
  sendInput(data: string | Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<unknown>;
  kill(): Promise<void>;
  disconnect(): Promise<void>;
  waitForConnection(): Promise<void>;
}

export const terminalRoutes = new Hono<AppEnv>();
terminalRoutes.use("*", orgScope);

terminalRoutes.get(
  "/:id/terminal",
  upgradeWebSocket((c) => {
    // Per-connection state, filled in onOpen (async work happens there — the
    // upgrade callback itself must return handlers synchronously). Capture the
    // route param + org NOW — context reads inside async ws callbacks are not
    // reliable across hono/bun versions.
    const runId = c.req.param("id") ?? "";
    const orgId = c.get("orgId");
    let pty: PtyLike | null = null;
    let closed = false;

    return {
      onOpen: (_evt, ws) => {
        void (async () => {
          const send = (s: string) => {
            try {
              ws.send(s);
            } catch {
              /* socket already gone */
            }
          };
          try {
            const run = await getRunForOrg(orgId, runId);
            if (!run) {
              throw new Error(
                `run not found (${runId.slice(0, 8) || "no id"} org=${orgId ?? "none"})`,
              );
            }
            const sandbox = await resolvePreviewSandbox(run.threadId);
            const sandboxId = sandbox.id;
            const state = (sandbox as { state?: string }).state;
            if (state === "stopped" || state === "paused" || state === "archived") {
              send("\r\n\x1b[2m[useAgent] waking sandbox…\x1b[0m\r\n");
              await sandbox.start();
            }

            const cols = Number(c.req.query("cols") ?? 100) || 100;
            const rows = Number(c.req.query("rows") ?? 30) || 30;
            const decoder = new TextDecoder();
            const handle = await sandbox.process.createPty({
              id: `skynet-term-${run.id.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
              cols,
              rows,
              onData: (data: Uint8Array) => {
                if (!closed) send(decoder.decode(data));
              },
            });
            await handle.waitForConnection();
            pty = handle as unknown as PtyLike;
            // The race where the browser closed while we were provisioning.
            if (closed) {
              await handle.kill().catch(() => {});
              await handle.disconnect().catch(() => {});
              return;
            }
            send("\x1b[2m[useAgent] connected to sandbox " + sandboxId.slice(0, 8) + "\x1b[0m\r\n");
            await pty.sendInput("cd ~/work 2>/dev/null; clear\n");
          } catch (err) {
            const message = errorMessage(err);
            // A reaped/absent sandbox is the NORMAL idle state between runs,
            // not a fault: send the dim "no live sandbox" notice (the client
            // filters that phrase into one calm waiting line) instead of a red
            // error that repeats on every reconnect.
            if (/not found|no live sandbox/i.test(message)) {
              send("\r\n\x1b[2m[useAgent] no live sandbox yet\x1b[0m\r\n");
            } else {
              send(`\r\n\x1b[31m[useAgent] ${message}\x1b[0m\r\n`);
            }
            try {
              ws.close();
            } catch {
              /* already closed */
            }
          }
        })();
      },

      onMessage: (evt) => {
        if (!pty) return;
        try {
          const msg = JSON.parse(String(evt.data)) as {
            type?: string;
            data?: string;
            cols?: number;
            rows?: number;
          };
          if (msg.type === "input" && typeof msg.data === "string") {
            void pty.sendInput(msg.data).catch(() => {});
          } else if (msg.type === "resize" && msg.cols && msg.rows) {
            void pty.resize(msg.cols, msg.rows).catch(() => {});
          }
        } catch {
          /* ignore malformed frames */
        }
      },

      onClose: () => {
        closed = true;
        const h = pty;
        pty = null;
        if (h) {
          void h.kill().catch(() => {});
          void h.disconnect().catch(() => {});
        }
      },
    };
  }),
);
