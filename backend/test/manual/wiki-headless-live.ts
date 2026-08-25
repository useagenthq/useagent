/**
 * LIVE headless proof for Slice B (mem_op.md 0.3) — the Wiki PAGE renders PUBLISHED
 * knowledge documents from the backend (not static content), and a DRAFT/ARCHIVED
 * doc does not appear. Boots a real backend + a real Next dev server and asserts on
 * the server-rendered /wiki HTML.
 *
 *   bun run test/manual/wiki-headless-live.ts
 *
 * Isolated: throwaway DB useagent_kbgw_wiki, backend :3417, Next :3416. Needs the
 * worktree frontend to have real node_modules (bun install; Turbopack rejects a
 * symlink). Requires nothing external.
 */
import { openSync, readFileSync } from "node:fs";
import postgres from "postgres";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB = "useagent_kbgw_wiki";
const DB_URL = `postgres://postgres@localhost:5432/${DB}`;
const BE = 3417;
const FE = 3416;
const backendDir = new URL("../..", import.meta.url).pathname;
const frontendDir = new URL("../../../frontend", import.meta.url).pathname;
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const beLog = `${scratch}/kbgw-wiki-be.log`;
const feLog = `${scratch}/kbgw-wiki-fe.log`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function recreateDb() {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
}
async function dropDb() {
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await admin.end();
}

async function up(url: string, timeoutMs: number, ok = (r: Response) => r.ok): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (ok(await fetch(url))) return true;
    } catch {
      /* not up */
    }
    await sleep(500);
  }
  return false;
}

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`http://localhost:${BE}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function wikiHtml(): Promise<string> {
  const res = await fetch(`http://localhost:${FE}/wiki?t=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
  return res.text();
}

async function main() {
  console.log("LIVE Slice B — Next /wiki SSR renders published knowledge documents");
  await recreateDb();

  const beFd = openSync(beLog, "a");
  const backend = Bun.spawn(["bun", "src/index.ts"], {
    cwd: backendDir,
    env: { ...process.env, PORT: String(BE), DATABASE_URL: DB_URL, USEAGENT_DEV_MODE: "true", MEMORY_API_URL: "", FRONTEND_ORIGIN: `http://localhost:${FE}` },
    stdout: beFd,
    stderr: beFd,
  });
  const feFd = openSync(feLog, "a");
  const frontend = Bun.spawn(["bunx", "next", "dev", "-p", String(FE)], {
    cwd: frontendDir,
    env: { ...process.env, USEAGENT_API_ORIGIN: `http://localhost:${BE}`, PORT: String(FE) },
    stdout: feFd,
    stderr: feFd,
  });

  try {
    check("backend booted", await up(`http://localhost:${BE}/api/health`, 30_000));

    // Seed + publish a unique doc into the dev org (anonymous dev fallback).
    const canary = `wikilive${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const title = `Runbook ${canary}`;
    const created = await api("/api/knowledge/documents", {
      title,
      content: `This published page proves the Wiki is backed by knowledge. Secret marker: ${canary}.`,
    });
    check("draft document created", !!created.document?.id, `id=${created.document?.id?.slice(0, 8)} status=${created.document?.status}`);
    const docId = created.document.id;

    // While still a DRAFT, /wiki must NOT show it. Boot Next first (first hit compiles).
    check("Next dev server serving /wiki", await up(`http://localhost:${FE}/wiki`, 120_000, (r) => r.status === 200), "(first hit compiles via Turbopack)");
    const draftHtml = await wikiHtml();
    check("a DRAFT does NOT appear on the Wiki page", !draftHtml.includes(canary));
    check("Wiki shows the empty state while nothing is published", draftHtml.includes("No published pages yet"));
    check("old STATIC wiki content is gone", !draftHtml.includes("Auto-generated wiki") && !draftHtml.includes("app router pages"));

    // Publish → the page renders it.
    const pub = await api(`/api/knowledge/documents/${docId}/publish`, {});
    check("document published", pub.document?.status === "published");
    await sleep(500);
    const pubHtml = await wikiHtml();
    check("PUBLISHED document appears on the Wiki page (title)", pubHtml.includes(title));
    check("PUBLISHED document content is rendered (marker)", pubHtml.includes(canary));

    // Archive → the page drops it again.
    await api(`/api/knowledge/documents/${docId}/archive`, {});
    await sleep(500);
    const archHtml = await wikiHtml();
    check("ARCHIVED document no longer appears on the Wiki page", !archHtml.includes(canary));
  } catch (e) {
    check("wiki headless proof threw", false, (e as Error).message);
  } finally {
    frontend.kill(9);
    backend.kill(9);
    await Promise.all([frontend.exited.catch(() => {}), backend.exited.catch(() => {})]);
    await dropDb();
  }

  console.log(`\n${fail === 0 ? "✅ LIVE SLICE B PROOF PASSED" : `❌ LIVE PROOF FAILED (${fail})`}`);
  if (fail > 0) {
    for (const [name, log] of [["frontend", feLog], ["backend", beLog]] as const) {
      try {
        console.log(`  ── ${name} log tail ──`);
        for (const l of readFileSync(log, "utf8").trimEnd().split("\n").slice(-15)) console.log(`  │ ${l}`);
      } catch { /* no log */ }
    }
  }
  process.exit(fail === 0 ? 0 : 1);
}

await main();
