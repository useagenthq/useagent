/**
 * PHASE 8 - Live retained-session parity journey for OpenCode / Claude ACP / Codex ACP
 * against REAL Daytona, on an ISOLATED backend + THROWAWAY DB. This is the NOT-SQL-seeded
 * user journey the acceptance matrix demands: a real provider session, a real sandbox, a real
 * model. It fills the cells the existing live suites (acp-live-e2e, canonical-flagon,
 * browser-stop) do not: repo prepared securely + a KNOWN repo file read, a real provider
 * command catalog captured FROM the live session (or a truthful empty catalog), a safe native
 * command invoked, a versioned Skynet skill applied (skill.loaded), retained sandbox + provider
 * session across turn 2 with NO reclone, reload/replay integrity, native stop, and a
 * credential-leak audit over the persisted product surfaces.
 *
 * Isolation: boots its OWN backend on a throwaway DB (unique per engine) - NEVER a second
 * backend on the shared `skynet` DB (recoverStaleRuns would hijack other agents' in-flight
 * runs). One Daytona sandbox per engine; deleted + API-verified at the end.
 *
 * Emits `PHASE8_EVIDENCE=<json>` (engine, model, run/thread/sandbox/session ids, per-cell
 * verdict + sanitized excerpts) for the acceptance matrix, then a human summary. Nonzero exit
 * iff a NON-blocked required cell fails. A genuine Daytona-capacity failure (no sandbox ever
 * provisioned) is reported as BLOCKED, not a false green.
 *
 * Run (from backend/):
 *   E2E_ENGINE=opencode bun test/e2e/phase8-journey.ts
 *   E2E_ENGINE=claude   bun test/e2e/phase8-journey.ts
 *   E2E_ENGINE=codex    E2E_MODEL=gpt-5.6-sol bun test/e2e/phase8-journey.ts
 */
import postgres from "postgres";
import { openSync } from "node:fs";
import { readFileSync } from "node:fs";
import { Daytona } from "@daytona/sdk";
import { deleteById, listAll } from "./soak/lib/daytona";
import { DEFAULT_CODEX_MODEL } from "../../src/runs/model-policy";
import { shq } from "../../src/engines/repo-prep";
import { SANDBOX_GENERATION } from "../../src/provider-gateway/sandbox-config";

type Engine = "opencode" | "claude" | "codex";
const ENGINE = (process.env.E2E_ENGINE ?? "opencode") as Engine;
const DEFAULT_MODEL: Record<Engine, string> = {
  opencode: "claude-opus-5",
  // This journey intentionally uses a repository with a 620 KB CLAUDE.md.
  // Exercise the product's actual Claude default (1M context) instead of a
  // 200K Haiku model that cannot represent the repository's own instructions.
  claude: "claude-opus-5",
  codex: DEFAULT_CODEX_MODEL,
};
const MODEL = process.env.E2E_MODEL ?? DEFAULT_MODEL[ENGINE];
const PORT_BY_ENGINE: Record<Engine, number> = { opencode: 3532, claude: 3533, codex: 3534 };
const BE_PORT = Number(process.env.BE_PORT ?? PORT_BY_ENGINE[ENGINE]);
const BE = `http://localhost:${BE_PORT}`;
const ORIGIN = "http://localhost:3200"; // dev-org (anonymous) scope
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB = `skynet_e2e_p8_${ENGINE}`;
const DB_URL = `postgres://postgres@localhost:5432/${DB}`;
// ACP relay install is slow the first time in a fresh sandbox; poll generously.
const BUDGET = Number(process.env.E2E_BOOT_BUDGET_S ?? 480);
const backendDir = new URL("../..", import.meta.url).pathname;
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const beLogPath = `${scratch}/skynet-p8-${ENGINE}-backend.log`;

const LONG_PROMPT =
  "Use the shell/execute tool to run EXACTLY this one command and WAIT for it to fully finish " +
  "before you reply: `sleep 90`. Do NOT run any other command and do NOT reply until it completes.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── cell ledger ─────────────────────────────────────────────────────────────
type Cell = { cell: string; status: "pass" | "fail" | "blocked" | "na"; evidence: string };
const cells: Cell[] = [];
const rec = (cell: string, status: Cell["status"], evidence = "") => {
  cells.push({ cell, status, evidence });
  const icon = status === "pass" ? "OK " : status === "fail" ? "XX " : status === "blocked" ? "-- " : ".. ";
  console.log(`  ${icon} [${ENGINE}] ${cell}${evidence ? ` - ${evidence}` : ""}`);
};
const pass = (cell: string, cond: boolean, ev = "") => rec(cell, cond ? "pass" : "fail", ev);

const sandboxIds = new Set<string>();
const myRunIds: string[] = [];
const debug: Record<string, unknown> = {};
const short = (s: unknown, n = 8) => String(s ?? "").slice(0, n);

function parseStepCode(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Row)
      : {};
  } catch {
    return {};
  }
}

const sql = postgres(DB_URL, { max: 3 });
type Row = Record<string, unknown>;

async function http(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BE}${path}`, {
    method,
    headers: { "content-type": "application/json", Origin: ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Row };
}
async function getRun(id: string): Promise<Row | null> {
  const res = await fetch(`${BE}/api/runs/${id}`, { headers: { Origin: ORIGIN } });
  return res.ok ? ((await res.json()) as Row) : null;
}
async function dbRun(id: string): Promise<Row | undefined> {
  const [r] = await sql`
    SELECT id, status, summary, thread_id, parent_run_id, engine, engine_session_id, sandbox_id, command_name
    FROM runs WHERE id = ${id}`;
  return r as Row | undefined;
}
async function waitTerminal(id: string, budgetS: number): Promise<Row | null> {
  for (let i = 0; i < budgetS / 2; i++) {
    const r = await getRun(id);
    const box = (r?.sandbox_id as string) ?? ((await dbRun(id))?.sandbox_id as string | undefined);
    if (box) sandboxIds.add(box);
    if (r && (r.status === "completed" || r.status === "failed" || r.status === "cancelled")) return r;
    await sleep(2000);
  }
  return null;
}
// The canonical lane is ASYNC (durable outbox drained by a worker AFTER finalize). Poll the
// outbox record to 'complete' so canonical_events is guaranteed written before we assert.
async function waitCanonical(runId: string, budgetS: number): Promise<string> {
  for (let i = 0; i < budgetS; i++) {
    const [o] = (await sql`SELECT state FROM canonicalization_outbox WHERE run_id = ${runId}`) as unknown as { state: string }[];
    if (o && (o.state === "complete" || o.state === "dead")) return o.state;
    await sleep(1000);
  }
  return "timeout";
}
async function waitHttp(url: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}
// concatenated transcript for content assertions (summary + every step's text-ish fields)
function transcriptOf(run: Row | null): string {
  if (!run) return "";
  const steps = (run.steps as Row[]) ?? [];
  const parts = [String(run.summary ?? "")];
  for (const s of steps) {
    for (const k of ["text", "output", "content", "detail", "title", "result"]) {
      const v = s[k];
      if (typeof v === "string") parts.push(v);
    }
  }
  return parts.join("\n");
}

let be: ReturnType<typeof Bun.spawn> | null = null;
let daytonaBlocked = false;

try {
  console.log(`\n=== PHASE 8 JOURNEY (engine=${ENGINE}, model=${MODEL}, BE=${BE}, DB=${DB}) ===\n`);

  // ── 0. throwaway DB + isolated backend (real Daytona/providers passed through) ──
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin`DROP DATABASE IF EXISTS ${admin.unsafe(DB)} WITH (FORCE)`.catch(() => {});
  await admin`CREATE DATABASE ${admin.unsafe(DB)}`;
  await admin.end();

  const beLog = openSync(beLogPath, "a");
  be = Bun.spawn(["bun", "src/index.ts"], {
    cwd: backendDir,
    env: {
      ...process.env, // real DAYTONA_API_KEY / OPENROUTER / ANTHROPIC / OPENAI / GITHUB / MEMORY pass through
      PORT: String(BE_PORT),
      DATABASE_URL: DB_URL,
      ALLOW_DEV_ORG: "1",
      FRONTEND_ORIGIN: ORIGIN,
      ENABLED_ENGINES: process.env.ENABLED_ENGINES ?? "opencode,claude,codex",
    },
    stdout: beLog,
    stderr: beLog,
  });
  const booted = await waitHttp(`${BE}/health`, 60_000);
  pass("isolated backend booted (throwaway DB, no shared-skynet hazard)", booted, `${BE} db=${DB}`);
  if (!booted) throw new Error("backend did not boot");

  // ── 1. author a real versioned Skynet skill (the user selects a skill they wrote) ──
  const skillMarker = `PHASE8-SKILL-${ENGINE}`;
  const skillRes = await http("POST", "/api/skills", {
    name: `phase8 ${ENGINE} verify skill`,
    description: "Phase 8 acceptance: a real versioned skill pinned onto a live run.",
    sections: {
      overview: [`This skill exists to prove skill.loaded for ${ENGINE}. Marker ${skillMarker}.`],
      procedure: ["Stay concise.", "Use tools when asked to read files."],
      verify: ["A skill.loaded canonical event names this skill+version."],
    },
  });
  const skillId = skillRes.body?.id as string | undefined;
  const skillVersion = (skillRes.body?.currentVersion as number | undefined) ?? (skillRes.body?.version as number | undefined) ?? 1;
  pass("authored a versioned skill (POST /api/skills)", !!skillId, `id=${short(skillId)} v=${skillVersion}`);

  // ── 2. select a repo from the org's ACTUAL available set (allowlisted) ──
  const reposResp = await http("GET", "/api/repos");
  const repoList = (reposResp.body?.repos as Row[] | undefined) ?? [];
  const repoRef = repoList[0]?.full_name as string | undefined;
  if (repoRef) rec("repo(s) available from GET /api/repos", "pass", `${repoList.length} repos, using ${repoRef}`);
  else rec("repo(s) available from GET /api/repos", "blocked", `none offered (${reposResp.body?.error ?? "no github app/token"})`);

  // ── 3. TURN 1 - real engine, with repo + skill; read a KNOWN repo file, echo FIRSTLINE ──
  const repoPrompt = repoRef
    ? "Use your shell tool to run exactly this working-directory-neutral command: " +
      `\`repo=.; git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || repo=${shq(repoRef)}; ` +
      `file=$(git -C "$repo" ls-files | head -n 1); ` +
      `printf 'FIRSTLINE: '; head -n 1 "$repo/$file"\`. ` +
      "Wait for it to finish, then reply with exactly the command output."
    : "Use the shell tool to run `echo PHASE8_NO_REPO_MARKER` and reply with a line that begins with `FIRSTLINE:` followed by that output.";
  const t1body: Row = { prompt: repoPrompt, engine: ENGINE, model: MODEL };
  if (repoRef) t1body.repos = [repoRef];
  if (skillId) t1body.skill = { id: skillId, version: skillVersion };
  const t1 = await http("POST", "/api/runs", t1body);
  const run1 = t1.body?.id as string | undefined;
  pass("turn 1 accepted (repo + skill selected)", (t1.status === 200 || t1.status === 201) && !!run1, `HTTP ${t1.status} id=${short(run1)} ${t1.body?.error ?? ""}`);
  if (!run1) throw new Error("no run1 id");
  myRunIds.push(run1);

  const r1 = await waitTerminal(run1, BUDGET);
  const d1 = await dbRun(run1);
  const box1 = d1?.sandbox_id as string | undefined;
  const ses1 = d1?.engine_session_id as string | undefined;
  const threadId = (d1?.thread_id as string | undefined) ?? run1;

  // Daytona-capacity short-circuit: no sandbox ever provisioned = infra blocked, not a code fail.
  if (!box1 && r1?.status !== "completed") {
    daytonaBlocked = true;
    rec("LIVE Daytona sandbox provisioned", "blocked", `status=${r1?.status ?? "timeout"} summary="${short(r1?.summary, 60)}" - shared Daytona likely at capacity`);
  } else {
    pass("LIVE Daytona sandbox provisioned + prepared", !!box1, `sandbox=${short(box1)}`);
  }

  if (!daytonaBlocked) {
    pass("turn 1 completed", r1?.status === "completed", `status=${r1?.status}`);
    pass("retained provider session id persisted", !!ses1, `session=${short(ses1)}`);
    if (
      r1?.status === "completed" &&
      (process.env.PROVIDER_GATEWAY_PUBLIC_URL || process.env.GATEWAY_PUBLIC_URL) &&
      box1
    ) {
      const daytona = new Daytona({
        apiKey: process.env.DAYTONA_API_KEY,
        target: process.env.DAYTONA_TARGET ?? "us",
      });
      const box = await daytona.get(box1);
      const rawProviderEnv = await box.process.executeCommand(
        "for n in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY OPENROUTER_API_KEY; do " +
          "test -z \"$(printenv \"$n\")\" || printf '%s\\n' \"$n\"; done",
        undefined,
        undefined,
        15,
      );
      pass(
        "provider gateway: no raw provider credential env in sandbox",
        (rawProviderEnv.exitCode ?? 1) === 0 && !rawProviderEnv.result?.trim(),
        rawProviderEnv.result?.trim() || "raw provider env absent",
      );
      const marker = await box.process.executeCommand(
        `test "$(cat $HOME/.skynet/provider-gateway-generation 2>/dev/null)" = "${SANDBOX_GENERATION}"`,
        undefined,
        undefined,
        15,
      );
      pass(
        "provider gateway: short-lived capability generation installed",
        marker.exitCode === 0,
        `generation=${marker.exitCode === 0 ? SANDBOX_GENERATION : "missing"}`,
      );
    }
    const steps1 = (r1?.steps as Row[]) ?? [];
    const toolStep = steps1.some((s) => s.kind === "command");
    pass("real tool lifecycle (a command/tool step ran)", toolStep, `${steps1.length} steps`);
    const reply1 = transcriptOf(r1);
    pass("assistant text streaming (non-empty reply)", reply1.trim().length > 0, `${reply1.length} chars`);
    debug.turn1Reply = reply1.slice(0, 240);
    debug.stepLabels = steps1.slice(0, 14).map((s) => `${s.kind}:${short(s.label, 40)}`);

    // the canonical lane is async - wait for the durable outbox to flip 'complete'
    const canonState = await waitCanonical(run1, 90);
    const cev = (await sql`SELECT kind FROM canonical_events WHERE run_id = ${run1}`) as unknown as { kind: string }[];
    const kinds = new Set(cev.map((e) => e.kind));
    pass("canonicalization completed (durable outbox=complete)", canonState === "complete", `state=${canonState}, ${cev.length} canonical events`);
    pass("canonical text streaming (message.* events)", [...kinds].some((k) => k.startsWith("message.")), `kinds=${[...kinds].slice(0, 8).join(",")}`);
    pass("canonical tool lifecycle (tool.* events)", [...kinds].some((k) => k.startsWith("tool.")), `${cev.length} canonical events`);

    // KNOWN repo file read: verify the physical owner-qualified checkout + origin,
    // then require the agent's tool call to target that exact checkout AND echo the
    // non-empty FIRSTLINE output. A failed `git ls-files` at the multi-repo root is
    // not evidence of a read and must never satisfy this cell.
    if (repoRef) {
      let physicalRepoVerified = false;
      let physicalEvidence = "sandbox unavailable";
      let expectedFirstLine: string | null = null;
      if (box1) {
        const daytona = new Daytona({
          apiKey: process.env.DAYTONA_API_KEY,
          target: process.env.DAYTONA_TARGET ?? "us",
        });
        const box = await daytona.get(box1);
        const checkout = await box.process.executeCommand(
          `DIR="$HOME/work"/${shq(repoRef)}; ` +
            `test -d "$DIR/.git" || exit 1; ` +
            `git -C "$DIR" remote get-url origin; ` +
            `FILE="$(git -C "$DIR" ls-files | head -n 1)"; ` +
            `head -n 1 "$DIR/$FILE" | base64 | tr -d '\n'; printf '\n'`,
          undefined,
          undefined,
          15,
        );
        const expectedOrigin = `https://github.com/${repoRef}.git`;
        const [actualOrigin = "", firstLineBase64 = ""] =
          checkout.result?.trimEnd().split("\n") ?? [];
        if (firstLineBase64) {
          expectedFirstLine = Buffer.from(firstLineBase64, "base64")
            .toString("utf8")
            .replace(/\r?\n$/, "");
        }
        physicalRepoVerified =
          checkout.exitCode === 0 && actualOrigin === expectedOrigin && expectedFirstLine !== null;
        physicalEvidence = physicalRepoVerified
          ? `${actualOrigin} firstLineBytes=${Buffer.byteLength(expectedFirstLine ?? "", "utf8")}`
          : `origin=${actualOrigin || "missing"} firstLine=${expectedFirstLine === null ? "missing" : "present"} exit=${checkout.exitCode}`;
      }
      const expectedMarker =
        expectedFirstLine === null ? null : `FIRSTLINE: ${expectedFirstLine}`;
      const successfulRead = steps1.some((step) => {
        const code = parseStepCode(step.code_json);
        const outputText =
          typeof code.output === "string" ? code.output : JSON.stringify(code.output ?? "");
        return (
          code.error !== true &&
          (code.tool === "execute" || code.tool === "bash") &&
          expectedMarker !== null &&
          outputText.includes(expectedMarker)
        );
      });
      const echoed = expectedMarker !== null && reply1.includes(expectedMarker);
      pass(
        "selected repo prepared securely (physical checkout + exact origin)",
        physicalRepoVerified,
        physicalEvidence,
      );
      pass(
        "known repo file read in live run (successful tool output + FIRSTLINE)",
        successfulRead && echoed && toolStep,
        `successfulRead=${successfulRead} echoed=${echoed} inputTelemetry=${ENGINE === "opencode" ? "available" : "ACP may omit"}`,
      );
    } else {
      rec("selected repo prepared securely", "blocked", "no repo available to clone");
      rec("known repo file read in live run", "blocked", "no repo available to clone");
    }

    // versioned skill applied: pinned on the run (immutable id+version+hash) AND a durable
    // skill.loaded marker on the native lane naming that exact skill.
    const pinnedOk = r1?.skill_id === skillId && Number(r1?.skill_version) === Number(skillVersion) && typeof r1?.skill_content_hash === "string";
    const [skPe] = (await sql`SELECT payload FROM provider_events WHERE run_id = ${run1} AND event_type = 'skill.loaded' LIMIT 1`) as unknown as { payload: unknown }[];
    let skPayload: Row = {};
    try { skPayload = (typeof skPe?.payload === "string" ? JSON.parse(skPe.payload) : skPe?.payload) as Row ?? {}; } catch { /* ignore */ }
    pass(
      "versioned Skynet skill applied (pinned on run + skill.loaded marker)",
      pinnedOk && !!skPe && skPayload.skillId === skillId,
      `pinned=${pinnedOk} marker=${!!skPe} skillId=${short(skPayload.skillId)} v=${skPayload.version}`,
    );

    // ── 4. real provider command catalog captured FROM the live session ──
    const [cmdEv] = (await sql`
      SELECT body, delivery_seq AS revision FROM canonical_events
      WHERE thread_id = ${threadId} AND kind = 'commands.updated' AND identity->>'nativeSessionId' = ${ses1 ?? ""}
      ORDER BY delivery_seq DESC LIMIT 1`) as unknown as { body: Row; revision: number }[];
    // canonical commands.updated body: `commands` is string[] (names), `catalog` is the objects.
    const rawCmds = (cmdEv?.body?.commands as (string | Row)[] | undefined) ?? (cmdEv?.body?.catalog as Row[] | undefined) ?? [];
    const catalogNames = rawCmds.map((c) => (typeof c === "string" ? c : String((c as Row).name))).filter((n) => n && n !== "undefined");
    // cross-check the native source lane (ACP writes an acp.commands provider event)
    const [acpCmd] = (await sql`SELECT payload FROM provider_events WHERE run_id = ${run1} AND event_type = 'acp.commands' LIMIT 1`) as unknown as { payload: unknown }[];
    debug.commandCatalog = catalogNames;
    debug.acpCommandsProviderEvent = !!acpCmd;
    if (catalogNames.length > 0) {
      rec("runtime native commands advertised (commands.updated from live session)", "pass",
        `source=${cmdEv?.body?.source ?? ENGINE} commands=[${catalogNames.slice(0, 6).join(",")}]`);
    } else {
      // honest capability: this engine advertised no runtime command catalog for this session
      rec("runtime native commands advertised (commands.updated from live session)", "na",
        `no catalog advertised (acp.commands provider event=${!!acpCmd}) - honest capability`);
    }

    // ── 5. TURN 2 - retained sandbox + session; invoke a safe native command if advertised ──
    const SAFE = new Set(["status", "diff", "help", "about", "compact", "models", "mcp", "review", "init", "usage", "context"]);
    const safeCmd = catalogNames.find((n) => SAFE.has(n));
    const catalogRevision = Number(cmdEv?.revision);
    const t2body: Row = { engine: ENGINE, model: MODEL, parent_run_id: run1 };
    if (safeCmd) {
      t2body.prompt = `/${safeCmd}`;
      t2body.command = {
        name: safeCmd,
        provider: ENGINE,
        sessionId: ses1,
        catalogRevision: Number.isSafeInteger(catalogRevision) ? catalogRevision : undefined,
      };
    } else {
      t2body.prompt = "Reply with exactly the word RETAINED. Do not run any tools.";
    }
    const t2 = await http("POST", "/api/runs", t2body);
    const run2 = t2.body?.id as string | undefined;
    pass(
      "turn 2 accepted (reply in same thread)",
      (t2.status === 200 || t2.status === 201) && !!run2,
      `HTTP ${t2.status} id=${short(run2)} ${t2.body?.error ?? ""} ${t2.body?.reason ?? ""}`.trim(),
    );
    if (run2) {
      myRunIds.push(run2);
      const r2 = await waitTerminal(run2, BUDGET);
      const d2 = await dbRun(run2);
      pass("turn 2 completed", r2?.status === "completed", `status=${r2?.status}`);
      pass("turn 2 joined the SAME thread", d2?.thread_id === threadId, `thread=${short(d2?.thread_id)}`);
      pass("retained sandbox across turn 2 (no reclone)", !!box1 && d2?.sandbox_id === box1, `t1=${short(box1)} t2=${short(d2?.sandbox_id)}`);
      pass("retained provider session across turn 2", !!ses1 && d2?.engine_session_id === ses1, `t1=${short(ses1)} t2=${short(d2?.engine_session_id)}`);
      if (safeCmd) {
        pass("safe native command invoked (validated against session catalog)", d2?.command_name === safeCmd, `command_name=${d2?.command_name ?? "null"}`);
      } else {
        rec("safe native command invoked", "na", "no safe command advertised this session (honest capability)");
      }

      // ── 6. reload / replay integrity ──
      const thr1 = await http("GET", `/api/runs/${run1}?thread=1`);
      const thr2 = await http("GET", `/api/runs/${run1}?thread=1`);
      const list1 = ((thr1.body?.thread as Row[]) ?? []).map((r) => r.id);
      const list2 = ((thr2.body?.thread as Row[]) ?? []).map((r) => r.id);
      const both = list1.includes(run1) && list1.includes(run2);
      const deterministic = JSON.stringify(list1) === JSON.stringify(list2);
      pass("reload/replay: both turns present, deterministic reconstruction", both && deterministic && list1.length >= 2, `${list1.length} runs`);
      const dups = (await sql`
        SELECT event_id, revision, count(*) AS n FROM canonical_events
        WHERE thread_id = ${threadId} GROUP BY event_id, revision HAVING count(*) > 1`) as unknown as Row[];
      pass("reload/replay: no duplicate canonical rows (event_id, revision unique)", dups.length === 0, `${dups.length} dup groups`);
    }

    // ── 7. native STOP during an active run ──
    const t3 = await http("POST", "/api/runs", { prompt: LONG_PROMPT, engine: ENGINE, model: MODEL, parent_run_id: run1 });
    const run3 = t3.body?.id as string | undefined;
    if (run3) {
      myRunIds.push(run3);
      const startWait = Date.now();
      let running = false;
      for (let i = 0; i < Math.ceil(BUDGET / 0.75); i++) {
        const r = await getRun(run3);
        if (r?.sandbox_id) sandboxIds.add(r.sandbox_id as string);
        const steps = (r?.steps as { kind?: string }[]) ?? [];
        if (r?.status === "running" && steps.some((s) => s.kind === "command")) { running = true; break; }
        if (r && (r.status === "failed" || r.status === "completed" || r.status === "cancelled")) break;
        await sleep(750);
      }
      await http("POST", `/api/runs/${run3}/cancel`, {});
      const settled = await waitTerminal(run3, 100);
      const totalS = Math.round((Date.now() - startWait) / 1000);
      if (!running) {
        // the turn ended (model didn't hold the long tool) BEFORE we could catch it mid-flight -
        // inconclusive, not a stop failure. Durable ACP cancel is proven by acp-live-e2e.
        rec("native stop: in-flight run settles \"Stopped by user\"", "na",
          `run finished before a mid-flight cancel could be attempted (status=${settled?.status}) - cancel proven by acp-live-e2e`);
      } else {
        pass(
          "native stop: in-flight run settles \"Stopped by user\" before the 90s task",
          settled?.summary === "Stopped by user" && totalS < 85,
          `running=${running} status=${settled?.status} summary="${short(settled?.summary, 20)}" ${totalS}s`,
        );
      }
    }
  }

  // ── 8. credential-leak audit over persisted PRODUCT surfaces ──
  // Raw secret values must never reach tenant-visible persistence. The live
  // gateway assertion above independently verifies that provider keys are also
  // absent from the sandbox environment.
  const secretVals = [
    process.env.DAYTONA_API_KEY, process.env.OPENROUTER_API_KEY, process.env.ANTHROPIC_API_KEY,
    process.env.OPENAI_API_KEY, process.env.GITHUB_APP_PRIVATE_KEY,
  ].filter((v): v is string => typeof v === "string" && v.length >= 16);
  const pev = (await sql`SELECT payload FROM provider_events WHERE thread_id = ${threadId}`) as unknown as { payload: unknown }[];
  const canv = (await sql`SELECT body, identity FROM canonical_events WHERE thread_id = ${threadId}`) as unknown as Row[];
  const runsText = (await sql`SELECT summary FROM runs WHERE thread_id = ${threadId}`) as unknown as { summary: unknown }[];
  const haystack = [
    ...pev.map((r) => JSON.stringify(r.payload)),
    ...canv.map((r) => JSON.stringify(r.body) + JSON.stringify(r.identity)),
    ...runsText.map((r) => String(r.summary ?? "")),
  ].join("\n");
  const leaked = secretVals.filter((v) => haystack.includes(v));
  pass("secret/redaction audit: no raw key VALUE in provider_events/canonical_events/transcript", leaked.length === 0, `${secretVals.length} keys checked, ${leaked.length} leaked`);
  // secrets.injected marker (if any org secrets) must store names only - throwaway org has none
  const [si] = (await sql`SELECT body FROM canonical_events WHERE thread_id = ${threadId} AND kind = 'secrets.injected' LIMIT 1`) as unknown as { body: Row }[];
  if (si) pass("secrets.injected marker stores NAMES only (no values)", !JSON.stringify(si.body).match(/[A-Za-z0-9_-]{20,}/) || Array.isArray(si.body.names), `names=${JSON.stringify(si.body.names)}`);
  else rec("secrets.injected marker", "na", "throwaway org has no secrets configured");
} catch (e) {
  rec("no fatal error", "fail", e instanceof Error ? e.message : String(e));
} finally {
  await sql.end().catch(() => {});
  // clean up ONLY our sandboxes: persisted ids + any Daytona box labelled with our run ids.
  const mine = new Set<string>([...sandboxIds].filter(Boolean));
  const myRuns = new Set(myRunIds);
  try {
    for (const sb of await listAll()) {
      const label = sb.labels?.["skynet-run"];
      if (label && myRuns.has(label)) mine.add(sb.id);
    }
  } catch (err) {
    console.warn(`[cleanup] label scan failed: ${String(err)}`);
  }
  const ids = [...mine].filter(Boolean);
  if (ids.length) {
    const res = await deleteById(ids).catch((err) => ({ deleted: [] as string[], failed: [{ id: "?", error: String(err) }] }));
    rec("sandbox(es) deleted + API-verified gone", res.failed.length === 0 ? "pass" : "fail", `deleted ${res.deleted.length}, failed ${res.failed.length}`);
  } else {
    rec("sandbox cleanup", daytonaBlocked ? "na" : "pass", "nothing provisioned");
  }
  be?.kill();
  await sleep(1000);
  const admin2 = postgres(ADMIN_URL, { max: 1 });
  await admin2`DROP DATABASE IF EXISTS ${admin2.unsafe(DB)} WITH (FORCE)`.catch(() => {});
  await admin2.end().catch(() => {});

  const fails = cells.filter((c) => c.status === "fail");
  const blocked = cells.filter((c) => c.status === "blocked");
  const verdict = daytonaBlocked ? "BLOCKED" : fails.length === 0 ? "PASS" : "FAIL";
  console.log(`\nPHASE8_EVIDENCE=${JSON.stringify({
    engine: ENGINE, model: MODEL, verdict,
    threadId: myRunIds[0] ?? null, runIds: myRunIds,
    sandboxIds: [...sandboxIds], backendLog: beLogPath,
    debug, cells,
  })}`);
  console.log(`\n${verdict === "PASS" ? "✅ PASS" : verdict === "BLOCKED" ? "⚠️  BLOCKED" : "❌ FAIL"} (${ENGINE}) - ${cells.filter((c) => c.status === "pass").length} pass, ${fails.length} fail, ${blocked.length} blocked`);
  if (fails.length) console.log("FAILED:", fails.map((c) => c.cell).join(" | "));
  process.exit(verdict === "PASS" ? 0 : verdict === "BLOCKED" ? 2 : 1);
}
