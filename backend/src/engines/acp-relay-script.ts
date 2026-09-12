// The dependency-free relay staged into every ACP sandbox (claude, codex). It is a
// string because it is base64-shipped and started with the sandbox's node; keep it
// free of backend imports. acp-server.ts boots it and talks to it over the preview link.

/** The in-sandbox relay: stdin/stdout bridge to the ACP agent over plain HTTP
 *  (SSE out, POST in) - WebSockets are unnecessary and unproven through the
 *  preview proxy, SSE is proven (opencode /event). Node built-ins only. */
export const RELAY_SCRIPT = `
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const PORT = Number(process.argv[2]);
const CMD = process.argv[3];
const ARGS = process.argv.slice(4);
let child = null;
let generation = 0;   // bumps on every (re)boot of the ACP CHILD (the relay HTTP server stays up)
let childAlive = false;
let childReady = false; // the child is spawned AND has had a moment to come up (accept stdin)
let lastExit = null;
let shuttingDown = false;
const clients = new Set();
function emit(line) { for (const res of clients) res.write("data: " + line + "\\n\\n"); }
function boot() {
  let buf = "";
  generation += 1;
  childReady = false;
  child = spawn(CMD, ARGS, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  childAlive = true;
  // READINESS: mark ready once the child produces its first stdout (an ACP agent greets on
  // start), or after a short grace window - whichever comes first. Until then /send is rejected
  // so we never write a prompt into a child that is not yet accepting input.
  const readyTimer = setTimeout(() => { if (childAlive) childReady = true; }, 750);
  child.stdout.on("data", (d) => {
    childReady = true;
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) emit(line);
    }
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.on("exit", (code, signal) => {
    clearTimeout(readyTimer);
    childAlive = false;
    childReady = false;
    lastExit = { code, signal };
    // Tell connected clients the ACP CHILD died: the backend fails pending RPC immediately and
    // treats the next turn as a NEW generation (never prompts the stale native session).
    emit(JSON.stringify({ __relay: "child_exit", generation, code, signal }));
    if (!shuttingDown) setTimeout(boot, 1000); // respawn -> a NEW generation (unless shutting down)
  });
}
// CLEANUP: on relay shutdown, stop respawning and kill the child so it is never orphaned.
function cleanup() { shuttingDown = true; try { if (child) child.kill("SIGTERM"); } catch (e) {} process.exit(0); }
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
boot();
createServer((req, res) => {
  if (req.url === "/health") {
    // JSON so the backend can distinguish RELAY health from ACP CHILD health and observe the
    // child generation + readiness. No secrets - just liveness + generation + a sanitized last-exit.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ relay: "ok", generation, childAlive, childReady, pid: (child && child.pid) || null, lastExit }));
    return;
  }
  if (req.url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    res.write(":ok\\n\\n");
    clients.add(res);
    const hb = setInterval(() => res.write(":hb\\n\\n"), 15000);
    req.on("close", () => { clearInterval(hb); clients.delete(res); });
    return;
  }
  if (req.method === "POST" && req.url === "/send") {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      // Guard: never write into a dead/not-yet-ready child (its stdin would throw or be lost).
      if (!child || !childAlive || !childReady) { res.writeHead(503); res.end("child not ready"); return; }
      try { child.stdin.write(b.trim() + "\\n"); res.writeHead(204); res.end(); }
      catch (e) { res.writeHead(503); res.end(String(e)); }
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, "0.0.0.0");
`;

