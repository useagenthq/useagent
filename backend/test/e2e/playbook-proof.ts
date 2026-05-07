/**
 * REAL end-to-end proof for the Playbooks feature (skill kind = "playbook").
 * MANUAL-gated (spends real Daytona + LLM tokens):
 *
 *     bun run test/e2e/playbook-proof.ts
 *
 * It boots an isolated backend (throwaway DB `skynet_pb_proof`, PORT 3424 - NEVER
 * the shared `skynet` dev DB, NEVER :3401/:3501) with the REAL Daytona/opencode
 * keys from backend/.env (memory disabled so the proof never touches the shared
 * pool), then proves the substrate end to end on a REAL opencode(haiku) run:
 *
 *   1. Create a PLAYBOOK via the API (kind:"playbook") whose Procedure tells the
 *      agent to end every answer with a numbered VERIFY section.
 *   2. Run it (POST /api/skills/:id/run, engine=opencode) with a prompt.
 *   3. The REAL answer FOLLOWS the procedure (has a numbered VERIFY section) -
 *      proof the playbook content was injected as governing instructions.
 *   4. skill.loaded is attributed as a PLAYBOOK (payload.kind === "playbook").
 *   5. Versioning: an edit mints v2; the historical run stays pinned to v1 with
 *      its original content hash.
 *
 * Teardown deletes every sandbox this run created and drops the DB.
 */
import { openSync, readFileSync } from "node:fs";
import { Daytona } from "@daytona/sdk";
import postgres from "postgres";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB = "skynet_pb_proof";
const DB_URL = `postgres://postgres@localhost:5432/${DB}`;
const PORT = 3424;
const BASE = `http://localhost:${PORT}`;
const MODEL = "claude-haiku-4-5";
const backendDir = new URL("../..", import.meta.url).pathname;
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const backendLog = `${scratch}/skynet-playbook-proof-backend.log`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function note(msg: string): void {
  console.log(`  · ${msg}`);
}

const sql = postgres(DB_URL, { max: 4 });

async function recreateDb(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
}
async function dropDb(): Promise<void> {
  await sql.end().catch(() => {});
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await admin.end();
}

type Proc = ReturnType<typeof Bun.spawn>;
async function startBackend(): Promise<Proc> {
  const fd = openSync(backendLog, "a");
  // Copy the env but DISABLE memory (no shared-pool writes from a proof run) and
  // point at the throwaway DB / isolated port. The real Daytona/OpenRouter/
  // Anthropic keys ride through from backend/.env (Bun auto-loads it).
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  // Disable memory with an EMPTY value (present-but-falsy) rather than delete:
  // Bun auto-loads backend/.env in the child and would re-add a deleted key, but
  // it will NOT override a key already present in the spawn env. Same reason the
  // DATABASE_URL override below wins over .env's shared-`skynet` value.
  env.MEMORY_API_URL = "";
  env.PORT = String(PORT);
  env.DATABASE_URL = DB_URL;
  env.FRONTEND_ORIGIN = "http://localhost:3524";
  const proc = Bun.spawn(["bun", "src/index.ts"], { cwd: backendDir, env, stdout: fd, stderr: fd });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        console.log(`  backend up on :${PORT} (pid ${proc.pid})`);
        return proc;
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`backend did not come up (see ${backendLog})`);
}
async function killBackend(proc: Proc): Promise<void> {
  proc.kill(9);
  await proc.exited;
}
function tailLog(lines = 30): void {
  try {
    const all = readFileSync(backendLog, "utf8").trimEnd().split("\n");
    console.log(`  ── backend log tail (${backendLog}) ──`);
    for (const l of all.slice(-lines)) console.log(`  │ ${l}`);
  } catch {
    /* no log */
  }
}
async function waitFor(fn: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(1000);
  }
  return false;
}

async function api(path: string, body?: unknown, method = "POST"): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function cleanupSandboxes(): Promise<void> {
  if (!process.env.DAYTONA_API_KEY) return;
  console.log("\n── cleanup: deleting proof sandboxes ──");
  const runIds = new Set((await sql`select id from runs`.catch(() => [])).map((r) => r.id as string));
  const ids = new Set(
    (await sql`select distinct sandbox_id from runs where sandbox_id is not null`.catch(() => [])).map(
      (r) => r.sandbox_id as string,
    ),
  );
  const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY!, target: process.env.DAYTONA_TARGET ?? "us" });
  try {
    for await (const sb of d.list()) {
      const label = (sb as { labels?: Record<string, string> }).labels?.["skynet-run"];
      if (label && runIds.has(label)) ids.add(sb.id);
    }
  } catch {
    /* best-effort */
  }
  let deleted = 0;
  for (const id of ids) {
    try {
      await (await d.get(id)).delete();
      deleted++;
      console.log(`  🗑  deleted sandbox ${id.slice(0, 12)}`);
    } catch (e) {
      console.log(`  ⚠️  could not delete sandbox ${id.slice(0, 12)}: ${(e as Error).message}`);
    }
  }
  // API-verify the deletions (per repo Daytona hygiene rule). Daytona deletion is
  // eventually-consistent - a get() right after delete() can still resolve for a
  // beat (or return state "destroyed"), so poll briefly before asserting gone.
  for (const id of ids) {
    let gone = false;
    for (let i = 0; i < 15 && !gone; i++) {
      gone = await d
        .get(id)
        .then((sb) => ((sb as { state?: string })?.state ?? "") === "destroyed")
        .catch(() => true); // get() throwing = the sandbox is gone
      if (!gone) await sleep(1000);
    }
    check(`sandbox ${id.slice(0, 12)} deleted (API-verified gone)`, gone);
  }
  console.log(`  cleanup: ${deleted}/${ids.size} proof sandbox(es) deleted`);
}

async function main(): Promise<void> {
  console.log("REAL PLAYBOOK PROOF — real Daytona + opencode(claude-haiku-4-5), memory disabled");
  console.log(`  DB=${DB} PORT=${PORT} backend-log=${backendLog}`);
  if (!process.env.DAYTONA_API_KEY) {
    console.error("ABORT: DAYTONA_API_KEY not set — this proof needs a real sandbox.");
    process.exit(2);
  }

  await recreateDb();
  const proc = await startBackend();

  // Safety: confirm we are on the throwaway DB before ANY real work.
  const probe = await api("/api/runs", { prompt: "db-probe", engine: "mock", model: MODEL });
  const onThrowaway = (await sql`select 1 from runs where id = ${probe.body.id}`).length === 1;
  if (!onThrowaway) {
    console.error("ABORT: backend is NOT on the throwaway DB — refusing to continue");
    await killBackend(proc);
    process.exit(2);
  }
  note("safety probe: backend is on the throwaway DB");

  try {
    // 1. Create the PLAYBOOK. The Procedure is the observable contract: the agent
    //    must end its answer with a numbered VERIFY section.
    const uniq = crypto.randomUUID().slice(0, 8);
    const name = `Proof Playbook ${uniq}`;
    const created = await api("/api/skills", {
      name,
      kind: "playbook",
      description: "A proof playbook that forces a numbered VERIFY section.",
      tags: ["proof"],
      sections: {
        overview: ["This playbook governs how you answer, as a demonstrable procedure."],
        procedure: [
          "Answer the user's question in one short sentence.",
          "Then, always finish with a section headed exactly 'VERIFY:' on its own line.",
          "Under VERIFY:, list the checks you performed as a numbered list (1., 2., 3.).",
        ],
        verify: ["The answer ends with a VERIFY: section containing a numbered list."],
      },
    });
    check("playbook created (kind=playbook, v1)", created.status === 201 && created.body.kind === "playbook" && created.body.current_version === 1, `status=${created.status} kind=${created.body.kind} v=${created.body.current_version}`);
    const playbookId = created.body.id as string;

    // It appears under ?kind=playbook and NOT under ?kind=skill.
    const pbList = await api("/api/skills?kind=playbook", undefined, "GET");
    const skList = await api("/api/skills?kind=skill", undefined, "GET");
    check("playbook listed under ?kind=playbook only", pbList.body.skills.some((s: any) => s.id === playbookId) && !skList.body.skills.some((s: any) => s.id === playbookId));

    // 2. Run it on the REAL opencode engine.
    const prompt = `What is the capital of France? [proof ${uniq}]`;
    const ran = await api(`/api/skills/${playbookId}/run`, { prompt, engine: "opencode", model: MODEL });
    check("run accepted with the playbook pinned", ran.status === 201 && !!ran.body.id, `status=${ran.status}`);
    const runId = ran.body.id as string;
    note(`run ${runId} created; waiting for the REAL sandbox turn (up to 6 min)…`);

    // 3. Wait for terminal + assert the run pinned the playbook.
    let row: any = null;
    await waitFor(async () => {
      [row] = await sql`select id, status, summary, skill_id, skill_version, skill_content_hash from runs where id = ${runId}`;
      return row && (row.status === "completed" || row.status === "failed");
    }, 6 * 60 * 1000);
    check("run reached a terminal state", row?.status === "completed" || row?.status === "failed", `status=${row?.status}`);
    check("run pinned the playbook (id + v1)", row?.skill_id === playbookId && row?.skill_version === 1, `skill=${row?.skill_id?.slice(0, 8)} v=${row?.skill_version}`);
    const pinnedHashV1 = row?.skill_content_hash as string;

    // 4. skill.loaded is attributed as a PLAYBOOK.
    const [loaded] = await sql`select payload from provider_events where run_id = ${runId} and event_type = 'skill.loaded'`;
    const marker = loaded?.payload ? JSON.parse(loaded.payload as string) : null;
    check("skill.loaded marker attributed as a PLAYBOOK", marker?.kind === "playbook" && marker?.version === 1 && marker?.name === name, `kind=${marker?.kind} v=${marker?.version} name="${marker?.name}"`);
    check("skill.loaded marker is bounded (no content body)", marker && !("sections" in marker) && !("content" in marker));

    // 5. THE behavioral proof: the real answer FOLLOWS the procedure.
    const answer = String(row?.summary ?? "");
    const hasVerify = /VERIFY:/i.test(answer);
    const hasNumbered = /(^|\n)\s*1[.)]/.test(answer.split(/VERIFY:/i)[1] ?? "");
    check("REAL answer FOLLOWS the playbook procedure (VERIFY: section present)", hasVerify, `answer tail="${answer.slice(-160).replace(/\n/g, "\\n")}"`);
    check("VERIFY: section contains a numbered list (procedure step 3)", hasVerify && hasNumbered);

    // 6. Versioning: an edit mints v2; the historical run stays pinned to v1.
    const edited = await api(`/api/skills/${playbookId}`, {
      sections: {
        overview: ["Edited overview - the procedure now also asks for a confidence line."],
        procedure: [
          "Answer in one short sentence.",
          "Finish with a 'VERIFY:' section as a numbered list.",
          "Add a final 'Confidence: high/medium/low' line.",
        ],
        verify: ["VERIFY: numbered list plus a Confidence line."],
      },
    }, "PATCH");
    check("editing the playbook minted v2", edited.status === 200 && edited.body.current_version === 2, `status=${edited.status} v=${edited.body.current_version}`);

    const [after] = await sql`select skill_version, skill_content_hash from runs where id = ${runId}`;
    check("historical run STILL pinned to v1 (immutable)", after?.skill_version === 1 && after?.skill_content_hash === pinnedHashV1, `v=${after?.skill_version} hashStable=${after?.skill_content_hash === pinnedHashV1}`);

    note(`answer was: "${answer.replace(/\n/g, "\\n").slice(0, 300)}"`);
  } finally {
    await killBackend(proc).catch(() => {});
    await cleanupSandboxes().catch((e) => console.log(`  cleanup error: ${(e as Error).message}`));
    await dropDb();
  }

  console.log(`\n══ ${pass} PASS / ${fail} FAIL ══`);
  if (fail > 0) tailLog(40);
  console.log(fail === 0 ? "\n✅ PLAYBOOK PROOF PASSED" : `\n❌ PLAYBOOK PROOF FAILED (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
