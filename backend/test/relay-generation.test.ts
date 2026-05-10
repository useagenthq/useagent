// Phase 4 (real subprocess): the in-sandbox relay tracks the ACP CHILD generation. When ONLY
// the child dies (the relay HTTP server stays up), it emits a `child_exit` control frame so the
// backend can fail pending RPC immediately, and /health reports the NEW generation after the
// child respawns - so the next turn never prompts the stale native session. Runs the actual
// exported RELAY_SCRIPT against a fake child; no Daytona, no mocks of the relay itself.
import { describe, expect, test, afterAll } from "bun:test";
import { RELAY_SCRIPT } from "../src/engines/acp-server";
import { writeFileSync, rmSync } from "node:fs";

const PORT = 34597;
const BASE = `http://127.0.0.1:${PORT}`;
const scriptPath = `/tmp/skynet-relay-gen-${process.pid}.mjs`;
writeFileSync(scriptPath, RELAY_SCRIPT);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A fake "ACP child": stays alive quietly until killed (like a resident agent between turns).
const proc = Bun.spawn(["bun", scriptPath, String(PORT), "sh", "-c", "trap 'exit 0' TERM; while true; do sleep 0.2; done"], {
  stdout: "ignore",
  stderr: "ignore",
});

afterAll(() => {
  proc.kill();
  rmSync(scriptPath, { force: true });
});

async function health(): Promise<{ generation: number | null; childAlive: boolean; childReady: boolean; pid: number | null }> {
  const r = await fetch(`${BASE}/health`);
  return (await r.json()) as { generation: number | null; childAlive: boolean; childReady: boolean; pid: number | null };
}
const send = (body: string) => fetch(`${BASE}/send`, { method: "POST", body }).then((r) => r.status);

/** Read the /events SSE until a JSON data line satisfies `match`, or time out. */
async function waitForFrame(match: (o: Record<string, unknown>) => boolean, budgetMs: number): Promise<Record<string, unknown> | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budgetMs);
  try {
    const res = await fetch(`${BASE}/events`, { signal: ac.signal });
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data) continue;
        try {
          const o = JSON.parse(data) as Record<string, unknown>;
          if (match(o)) return o;
        } catch { /* non-JSON child stdout line */ }
      }
    }
  } catch { /* aborted */ } finally {
    clearTimeout(timer);
  }
  return null;
}

describe("relay ACP child generation (real subprocess)", () => {
  test("child death emits a child_exit frame + /health reports the NEW generation after respawn", async () => {
    // wait for the relay to come up
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      up = await health().then((h) => h.pid != null).catch(() => false);
      if (!up) await sleep(100);
    }
    expect(up).toBe(true);

    // Readiness: the child produces no stdout, so it becomes ready via the grace timer (<=1s).
    let before = await health();
    for (let i = 0; i < 20 && !before.childReady; i++) { await sleep(100); before = await health(); }
    expect(before.generation).toBe(1); // first child boot
    expect(before.childAlive).toBe(true);
    expect(before.childReady).toBe(true);
    expect(await send('{"x":1}')).toBe(204); // a ready child accepts /send
    const childPid = before.pid!;

    // Start listening for the child_exit control frame, THEN kill only the ACP child.
    const framePromise = waitForFrame((o) => o.__relay === "child_exit", 8000);
    await sleep(150);
    try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }

    const frame = await framePromise;
    expect(frame).not.toBeNull();
    expect(frame?.__relay).toBe("child_exit");
    expect(frame?.generation).toBe(1); // the exit is reported for the generation that died

    // While the child is dead (before respawn), /send is GUARDED (503, not a lost write).
    expect(await send('{"x":2}')).toBe(503);

    // The relay respawns the child (~1s) -> /health reports a HIGHER generation, still up.
    let after = before;
    for (let i = 0; i < 40; i++) {
      after = await health();
      if ((after.generation ?? 0) > 1 && after.childAlive) break;
      await sleep(150);
    }
    expect(after.generation).toBeGreaterThan(1);
    expect(after.childAlive).toBe(true);
  }, 20000);
});
