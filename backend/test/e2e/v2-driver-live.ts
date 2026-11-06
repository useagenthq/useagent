/**
 * LIVE protocol 2 driver proof (T3 V2 lane). Drives real runs through an
 * ISOLATED stack on a V2 E2B template and records what the runtime streamed.
 *
 *   V2_E2E_CREDS=<file> V2_E2E_TEMPLATE=<tpl> [V2_E2E_OUT=<dir>] bun run test/e2e/v2-driver-live.ts [scenario ...]
 *
 * Scenarios: codex, claude, opencode, recreate (the thread's sandbox replaced
 * between turns: the fresh runtime thread gets the plane's history once),
 * reload, hotreload (a limit changed under a live OpenCode session reaches its
 * next turn with no detach), approval, approval-opencode, approval-fast (answered the moment it is
 * asked), question, subagent, subagent-codex (Codex delegates through the
 * product's child sessions), stop, restart (all when none is named, question
 * only with a Claude key; `boot` runs none). Each runs in its own thread. A
 * failed scenario leaves the tail of each of its runtimes' traces in the log
 * directory.
 *
 * Isolation (never a shared stack): a throwaway database on the lane's own
 * Postgres (V2_E2E_ADMIN_URL, default :5438), backend :3531 and gateway :3532
 * with an explicit env (nothing inherited but PATH), and a quick tunnel to the
 * gateway so the sandbox reaches it. Keys come from V2_E2E_CREDS (CUBE_API_KEY
 * and any other CUBE_* setting, OPENAI_API_KEY, OPENROUTER_API_KEY, and
 * ANTHROPIC_API_KEY when Claude should run: without it the claude scenario is
 * skipped and the question and subagent turns run on OpenCode). A second protocol 2
 * subscriber in this process records each thread's stream items (and its
 * subagents' threads) to <V2_E2E_OUT>/frames/<scenario>.json. Teardown
 * deletes every sandbox the runs used, verifies each is gone, drops the
 * database, and stops the services and the tunnel.
 */
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { Sandbox } from "e2b";
import postgres from "postgres";
import { startPublicTunnel, tunnelProviderOrder, type PublicTunnel } from "./lib/public-tunnel";
import { SANDBOX_NAME_PREFIX, SANDBOX_STATE_DIR } from "../../src/sandboxes/sandbox-names";

const HOME = homedir();
const CREDS_PATH = process.env.V2_E2E_CREDS ?? "";
if (!CREDS_PATH) throw new Error("V2_E2E_CREDS (a KEY=value file) is required");
const TEMPLATE = process.env.V2_E2E_TEMPLATE ?? "";
const ADMIN_URL = process.env.V2_E2E_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5438/postgres";
const DB = "useagent_e2e_v2";
const DB_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${DB}`);
const PORT = 3531;
const GATEWAY_PORT = 3532;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.V2_E2E_OUT ?? `${tmpdir()}/v2-driver-live`;
const FRAMES_DIR = `${OUT_DIR}/frames`;
const LOG_DIR = `${OUT_DIR}/logs`;
const TURN_BUDGET_MS = 6 * 60_000;
const MODELS = {
  codex: process.env.V2_E2E_CODEX_MODEL,
  claude: process.env.V2_E2E_CLAUDE_MODEL ?? "claude-sonnet-5",
  opencode: process.env.V2_E2E_OPENCODE_MODEL,
};
const ALL = [
  "codex", "claude", "opencode", "recreate", "reload", "hotreload", "approval", "approval-opencode", "approval-fast", "question",
  "subagent", "subagent-codex", "stop", "restart",
] as const;
type Scenario = (typeof ALL)[number];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Proc = ReturnType<typeof Bun.spawn>;
type Row = Record<string, unknown>;

function readCreds(): Record<string, string> {
  const creds: Record<string, string> = {};
  for (const line of readFileSync(CREDS_PATH, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) creds[match[1]!] = match[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  for (const key of ["CUBE_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]) {
    if (!creds[key]) throw new Error(`${CREDS_PATH} has no ${key}`);
  }
  return creds;
}

const creds = readCreds();
const secrets = {
  PROVIDER_GATEWAY_SECRET: `provider-v2-${crypto.randomUUID()}-${crypto.randomUUID()}`,
  TOOL_GATEWAY_SECRET: `tool-v2-${crypto.randomUUID()}-${crypto.randomUUID()}`,
  SECRETS_ENCRYPTION_KEY: `encryption-v2-${crypto.randomUUID()}-${crypto.randomUUID()}`,
  BETTER_AUTH_SECRET: `auth-v2-${crypto.randomUUID()}-${crypto.randomUUID()}`,
  USEAGENT_OPERATOR_SECRET: `operator-v2-${crypto.randomUUID()}-${crypto.randomUUID()}`,
};
const sandboxEnv = {
  SANDBOX_PROVIDER: "cube",
  CUBE_API_URL: "https://api.e2b.app",
  CUBE_SANDBOX_DOMAIN: "e2b.app",
  // E2B's cloud proxy is https; without it the plugin runs the SDK in debug mode.
  CUBE_PROXY_SCHEME: "https",
  // No warm pool: every sandbox here belongs to a run, so teardown finds it.
  CUBE_T3_WARM_POOL_SIZE: "0",
  ...Object.fromEntries(Object.entries(creds).filter(([key]) => key.startsWith("CUBE_"))),
  RUNTIME_CUBE_TEMPLATE_ID: TEMPLATE,
  T3_CUBE_TEMPLATE_ID: TEMPLATE,
};
/** Questions and subagents run on Claude when there is a key for it, else on OpenCode. */
const AGENT_ENGINE = creds.ANTHROPIC_API_KEY ? "claude" : "opencode";
// This process reaches the sandboxes too (the recorder and the cleanup).
Object.assign(process.env, sandboxEnv);

function stackEnv(tunnelUrl: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME,
    NODE_ENV: "development",
    DATABASE_URL: DB_URL,
    GATEWAY_DATABASE_URL: DB_URL,
    PORT: String(PORT),
    GATEWAY_PORT: String(GATEWAY_PORT),
    FRONTEND_ORIGIN: "http://127.0.0.1:3400",
    GATEWAY_PUBLIC_URL: tunnelUrl,
    // The gateway reaches the control plane here (child sessions, approvals), as in production.
    USEAGENT_API_ORIGIN: BASE,
    PROVIDER_GATEWAY_PUBLIC_URL: tunnelUrl,
    ENABLED_ENGINES: "claude,codex",
    ENGINE_AUTH_MODE_CODEX: "provider_gateway",
    OPENAI_API_KEY: creds.OPENAI_API_KEY!,
    OPENROUTER_API_KEY: creds.OPENROUTER_API_KEY!,
    // The release evidence a deployment carries for the engines and providers it serves.
    ...(creds.ANTHROPIC_API_KEY ? {
      ANTHROPIC_API_KEY: creds.ANTHROPIC_API_KEY, PROVIDER_HEALTH_ANTHROPIC: "ready", ENGINE_READINESS_CLAUDE: "ready",
    } : {}),
    PROVIDER_HEALTH_OPENAI: "ready",
    PROVIDER_HEALTH_OPENROUTER: "ready",
    ENGINE_READINESS_CODEX: "ready",
    ENGINE_READINESS_OPENCODE: "ready",
    ...sandboxEnv,
    ...secrets,
  };
}

const sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
const e2b = { apiKey: creds.CUBE_API_KEY!, apiUrl: sandboxEnv.CUBE_API_URL, domain: sandboxEnv.CUBE_SANDBOX_DOMAIN };

/** The E2B sandboxes labelled with one of `runIds` (a thread's sandbox carries its first run). */
async function labelledSandboxes(runIds: ReadonlySet<string>): Promise<string[]> {
  const ids: string[] = [];
  const pages = Sandbox.list(e2b);
  while (pages.hasNext) {
    for (const info of await pages.nextItems()) {
      if (runIds.has(String(info.metadata?.["useagent-run"] ?? ""))) ids.push(info.sandboxId);
    }
  }
  return ids;
}

async function recreateDb(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
}

async function dropDb(): Promise<void> {
  await sql.end().catch(() => {});
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await admin.end();
}

async function startService(name: "backend" | "gateway", entry: string, port: number, env: Record<string, string>): Promise<Proc> {
  const log = openSync(`${LOG_DIR}/${name}.log`, "a");
  const proc = Bun.spawn(["bun", entry], { cwd: new URL("../..", import.meta.url).pathname, env, stdout: log, stderr: log });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.ok, () => false)) {
      console.log(`  ${name} up on :${port} (pid ${proc.pid})`);
      return proc;
    }
    if (proc.exitCode !== null) break;
    await sleep(300);
  }
  throw new Error(`${name} did not come up (see ${LOG_DIR}/${name}.log)`);
}

async function stop(proc: Proc | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  proc.kill(9);
  await proc.exited;
}

async function api(path: string, body?: unknown): Promise<Row> {
  const response = await fetch(`${BASE}${path}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({})) as Row;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(json)}`);
  return json;
}

/** The runs the scenario in progress created, for its failure trace. */
let scenarioRuns: string[] = [];

async function createRun(body: Row): Promise<string> {
  const id = (await api("/api/runs", body)).id;
  if (typeof id !== "string") throw new Error("run create returned no id");
  scenarioRuns.push(id);
  return id;
}

async function runRow(id: string): Promise<Row> {
  const [row] = await sql`select * from runs where id = ${id}`;
  if (!row) throw new Error(`run ${id} is missing`);
  return row;
}

const SETTLED = new Set(["completed", "failed", "cancelled"]);

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, budgetMs = TURN_BUDGET_MS, pollMs = 2_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(pollMs);
  }
}

const settled = (id: string, budgetMs?: number) =>
  waitFor(`run ${id} to settle`, async () => {
    const row = await runRow(id);
    return SETTLED.has(String(row.status)) ? row : null;
  }, budgetMs);

const eventOf = (runId: string, type: string) =>
  waitFor(`${type} on ${runId}`, async () => {
    const [row] = await sql`select payload from provider_events where run_id = ${runId} and event_type = ${type} order by seq limit 1`;
    return row ? (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Row : null;
  });

async function eventTypes(runId: string): Promise<string[]> {
  const rows = await sql`select event_type from provider_events where run_id = ${runId} order by seq`;
  return [...new Set(rows.map((row) => String(row.event_type)))];
}

/** A second protocol 2 subscriber on the run's thread and its subagents' threads. */
async function startRecorder(name: string, runId: string) {
  const { sandboxProvider } = await import("../../src/sandboxes/provider");
  const { openRuntimeSocket } = await import("../../src/engines/runtime-rpc-socket");
  const { RUNTIME_RPC } = await import("../../src/engines/runtime-v2-wire");
  const { buildRuntimeThreadSubscription } = await import("../../src/engines/runtime-event-stream");
  // The runtime has the thread once the run's first event is in.
  await waitFor(`the first event of ${runId}`, async () =>
    (await sql`select 1 from provider_events where run_id = ${runId} limit 1`).length > 0);
  const row = await runRow(runId);
  const sandboxId = await waitFor(`a sandbox labelled with ${runId}`, async () => (await labelledSandboxes(new Set([runId])))[0]);
  const sandbox = await sandboxProvider(creds.CUBE_API_KEY).get(sandboxId);
  const controller = new AbortController();
  const socket = await openRuntimeSocket({ sandbox, signal: controller.signal });
  const threads = new Map<string, unknown[]>();
  const streams: Promise<void>[] = [];
  const follow = (threadId: string) => {
    if (threads.has(threadId)) return;
    const items: unknown[] = [];
    threads.set(threadId, items);
    streams.push((async () => {
      for (let attempt = 1; !controller.signal.aborted; attempt += 1) {
        try {
          await socket.stream(RUNTIME_RPC.subscribeThread, buildRuntimeThreadSubscription(threadId), async (values) => {
            for (const value of values) {
              items.push(value);
              // A subagent's work streams only on its own thread.
              for (const child of JSON.stringify(value).matchAll(/"childThreadId":"([^"]+)"/g)) follow(child[1]!);
            }
            return !controller.signal.aborted;
          });
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          // The runtime creates the thread when its first turn starts.
          if (attempt < 90 && (error as Error).message.includes("Failed to load")) {
            await sleep(1_000);
            continue;
          }
          console.log(`  recorder on ${threadId} stopped: ${(error as Error).message}`);
          return;
        }
      }
    })());
  };
  follow(`${SANDBOX_NAME_PREFIX}-thread-${row.thread_id ?? runId}`);
  return async () => {
    await sleep(1_500);
    controller.abort();
    socket.close();
    await Promise.all(streams);
    mkdirSync(FRAMES_DIR, { recursive: true });
    writeFileSync(`${FRAMES_DIR}/${name}.json`, JSON.stringify(Object.fromEntries(threads), null, 2));
    console.log(`  recorded ${[...threads.values()].reduce((sum, items) => sum + items.length, 0)} stream items on ${threads.size} thread(s) -> ${FRAMES_DIR}/${name}.json`);
    return threads;
  };
}

/** A run of `engine` and its recorded thread; the next turns of the thread follow from `parent`. */
async function turn(engine: keyof typeof MODELS, prompt: string, extra: Row = {}): Promise<string> {
  const model = MODELS[engine];
  return await createRun({ prompt, engine, ...(model ? { model } : {}), permission_mode: "full-access", ...extra });
}

const results: { scenario: string; status: "PASS" | "FAIL" | "SKIP"; detail: string }[] = [];
function check(scenario: string, ok: boolean, detail: string): void {
  results.push({ scenario, status: ok ? "PASS" : "FAIL", detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${scenario}: ${detail}`);
}

async function simpleTurn(name: Scenario, engine: keyof typeof MODELS): Promise<void> {
  const first = await turn(engine, "Run `ls /` in the shell, then reply with the number of entries only.");
  const record = await startRecorder(name, first);
  const one = await settled(first);
  const second = await turn(engine, "Reply with the number you gave me last time, nothing else.", { parent_run_id: first });
  const two = await settled(second);
  await record();
  const types = await eventTypes(first);
  check(name, one.status === "completed" && two.status === "completed" && types.some((type) => type.startsWith("t3.activity.tool.")),
    `turn 1 ${one.status} "${String(one.summary ?? "").slice(0, 40)}", turn 2 ${two.status} "${String(two.summary ?? "").slice(0, 40)}", tool events ${types.filter((type) => type.startsWith("t3.activity.tool.")).join(",") || "none"}`);
}

async function approvalTurn(name: Scenario, engine: keyof typeof MODELS, pollMs = 2_000): Promise<void> {
  const first = await turn(engine, "Create the file /tmp/approval-proof.txt containing hello, using the shell, then say done.",
    { permission_mode: "approval-required" });
  const record = await startRecorder(name, first);
  // Every request is accepted as it arrives: an engine may ask once per command.
  const accepted = new Set<string>();
  const run = await waitFor(`run ${first} to settle`, async () => {
    for (const row of await sql`select payload from provider_events where run_id = ${first} and event_type = 'approval.requested' order by seq`) {
      const id = String((typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload).id);
      if (accepted.has(id)) continue;
      accepted.add(id);
      await api(`/api/runs/${first}/approvals/${encodeURIComponent(id)}/reply`, { decision: "accept" });
    }
    const current = await runRow(first);
    return SETTLED.has(String(current.status)) ? current : null;
  }, TURN_BUDGET_MS, pollMs);
  await record();
  const types = await eventTypes(first);
  check(name, run.status === "completed" && accepted.size > 0 && types.includes("approval.resolved"),
    `${engine}: ${accepted.size} request(s) accepted; run ${run.status} "${String(run.summary ?? "").slice(0, 80)}"; resolved=${types.includes("approval.resolved")}`);
}

async function subagentTurn(name: Scenario, engine: keyof typeof MODELS): Promise<void> {
  const first = await turn(engine, "Start exactly one subagent (your tool for delegating a task to another agent) that runs `echo subagent-proof` in the shell and reports the output. Then reply with what it reported.");
  const record = await startRecorder(name, first);
  const run = await settled(first);
  await record();
  const types = await eventTypes(first);
  // A native subagent is a child runtime thread; Codex instead delegates through
  // the product's child sessions, which are runs of their own.
  const children = (await sql`select id from runs where created_at > (select created_at from runs where id = ${first})`)
    .map((row) => String(row.id)).filter((id) => !scenarioRuns.includes(id));
  const childRuns = await Promise.all(children.map((id) => settled(id)));
  const delegated = childRuns.some((child) => child.status === "completed");
  check(name, run.status === "completed" && (types.includes("t3.activity.task.started") || delegated),
    `${engine}: run ${run.status}; task events ${types.filter((type) => type.includes("task.")).join(",") || "none"}; child events ${types.filter((type) => type.includes("child.")).join(",") || "none"}; product child runs ${childRuns.map((child) => child.status).join(",") || "none"}`);
}

const scenarios: Record<Scenario, () => Promise<void>> = {
  codex: () => simpleTurn("codex", "codex"),
  async claude() {
    if (!creds.ANTHROPIC_API_KEY) {
      results.push({ scenario: "claude", status: "SKIP", detail: "no ANTHROPIC_API_KEY in the creds file" });
      console.log("  SKIP claude: no ANTHROPIC_API_KEY in the creds file");
      return;
    }
    await simpleTurn("claude", "claude");
  },
  opencode: () => simpleTurn("opencode", "opencode"),

  async reload() {
    const { sandboxProvider } = await import("../../src/sandboxes/provider");
    const { readOpencodeSandboxConfig, writeOpencodeSandboxConfig } = await import("../../src/engines/opencode-sandbox-config");
    const first = await turn("opencode", "Reply with the word one.");
    const record = await startRecorder("reload", first);
    const one = await settled(first);
    // Change a model's limits in the sandbox's config: the next turn finds the
    // limits it writes differ, so it detaches the retained session first.
    const sandbox = await sandboxProvider(creds.CUBE_API_KEY).get(String(one.sandbox_id));
    const config = structuredClone(await readOpencodeSandboxConfig(sandbox)) as { provider?: Record<string, { models?: Record<string, { limit?: { context?: number } }> }> };
    let changed = 0;
    for (const provider of Object.values(config.provider ?? {})) {
      for (const model of Object.values(provider.models ?? {})) {
        if (typeof model.limit?.context === "number") { model.limit.context -= 1; changed += 1; }
      }
    }
    await writeOpencodeSandboxConfig(sandbox, config as never);
    const second = await turn("opencode", "Reply with the word two.", { parent_run_id: first });
    const two = await settled(second);
    await record();
    const log = readFileSync(`${LOG_DIR}/backend.log`, "utf8");
    check("reload", one.status === "completed" && two.status === "completed" && changed > 0 && !log.includes("refused the session detach"),
      `limits changed on ${changed} model(s); turn 2 ${two.status}`);
  },

  approval: () => approvalTurn("approval", "codex"),
  "approval-opencode": () => approvalTurn("approval-opencode", "opencode"),

  async question() {
    const first = await turn(AGENT_ENGINE, "Use your tool for asking the user a question to ask me whether I prefer red or blue (options: Red, Blue), then reply with my choice only.");
    const record = await startRecorder("question", first);
    const asked = await eventOf(first, "question.asked");
    const questions = (asked.questions as { options?: { label: string }[] }[] | undefined) ?? [];
    const answers = questions.map((question) => [question.options?.at(-1)?.label ?? "Blue"]);
    await api(`/api/runs/${first}/questions/${encodeURIComponent(String(asked.id))}/reply`, { answers });
    const run = await settled(first);
    await record();
    check("question", run.status === "completed" && /blue/i.test(String(run.summary ?? "")),
      `${AGENT_ENGINE}: answered ${JSON.stringify(answers)}; run ${run.status} "${String(run.summary ?? "").slice(0, 40)}"`);
  },

  subagent: () => subagentTurn("subagent", AGENT_ENGINE),
  "subagent-codex": () => subagentTurn("subagent-codex", "codex"),
  "approval-fast": () => approvalTurn("approval-fast", "codex", 100),

  async recreate() {
    const first = await turn("codex", "Remember the code word PLUM. Reply with ok only.");
    const one = await settled(first);
    // The thread's sandbox goes away, so the reply starts on a fresh runtime thread.
    for (const id of await labelledSandboxes(new Set([first]))) await Sandbox.kill(id, e2b);
    const second = await turn("codex", "What code word did I give you? Reply with the word only.", { parent_run_id: first });
    const record = await startRecorder("recreate", second);
    const two = await settled(second);
    const threads = await record();
    const records: Row[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        records.push(value as Row);
        Object.values(value).forEach(walk);
      }
    };
    walk([...threads.values()]);
    // What the fresh runtime thread received: the plane's history, once, and no handoff of its own.
    const text = records
      .filter((entry) => entry.role === "user" && entry.id === `${SANDBOX_NAME_PREFIX}-message-${second}` && typeof entry.text === "string")
      .map((entry) => String(entry.text)).at(-1) ?? "";
    const histories = text.split("This is an ONGOING conversation").length - 1;
    const handoffs = new Set(records.flatMap((entry) => [
      ...(typeof entry.contextHandoffId === "string" ? [entry.contextHandoffId] : []),
      ...(Array.isArray(entry.handoffIds) ? entry.handoffIds.map(String) : []),
    ])).size;
    check("recreate", one.status === "completed" && two.status === "completed" && /plum/i.test(String(two.summary ?? "")) &&
      histories === 1 && handoffs === 0,
      `turn 2 ${two.status} "${String(two.summary ?? "").slice(0, 30)}" on a new sandbox; plane history ${histories}x in its message (${text.length} chars); runtime handoffs ${handoffs}`);
  },

  async hotreload() {
    const { sandboxProvider } = await import("../../src/sandboxes/provider");
    const { readOpencodeSandboxConfig, writeOpencodeSandboxConfig } = await import("../../src/engines/opencode-sandbox-config");
    const { DEFAULT_OPENCODE_MODEL, openCodeRuntimeModelId } = await import("../../src/runs/model-policy");
    const first = await turn("opencode", "Reply with the word one.");
    const record = await startRecorder("hotreload", first);
    const one = await settled(first);
    // A context limit of our own for the run's model: the plane's per-turn
    // config write merges it, so the next turn changes nothing on its side.
    const [sandboxId] = await labelledSandboxes(new Set([first]));
    const sandbox = await sandboxProvider(creds.CUBE_API_KEY).get(sandboxId!);
    const config = structuredClone(await readOpencodeSandboxConfig(sandbox)) as { provider?: Record<string, { models?: Record<string, Row> }> };
    const [providerId, ...rest] = openCodeRuntimeModelId(MODELS.opencode ?? DEFAULT_OPENCODE_MODEL).split("/");
    const provider = (config.provider ??= {})[providerId!] ??= {};
    const models = provider.models ??= {};
    models[rest.join("/")] = { ...models[rest.join("/")], limit: { context: 400_000, output: 100_000 } };
    await writeOpencodeSandboxConfig(sandbox, config as never);
    await sleep(6_000);
    const second = await turn("opencode", "Reply with the word two.", { parent_run_id: first });
    const two = await settled(second);
    const threads = await record();
    const maxTokens: number[] = [];
    const sessions = new Set<string>();
    let detached = 0;
    for (const items of threads.values()) {
      for (const item of items as Row[]) {
        const event = item.event as Row | undefined;
        const payload = event?.payload as Row | undefined;
        if (event?.type === "provider-thread.updated") {
          const usage = payload?.contextUsage as Row | null | undefined;
          if (typeof usage?.maxTokens === "number" && usage.maxTokens !== maxTokens.at(-1)) maxTokens.push(usage.maxTokens);
        }
        if (event?.type === "provider-session.attached") sessions.add(String(payload?.id));
        if (event?.type === "provider-session.detached") detached += 1;
      }
    }
    check("hotreload", one.status === "completed" && two.status === "completed" && detached === 0 && sessions.size === 1 &&
      maxTokens.length >= 2 && maxTokens.at(-1) !== maxTokens[0],
      `model ${providerId}/${rest.join("/")}; context window ${maxTokens.join(" -> ") || "none"}; sessions ${sessions.size}, detaches ${detached}; turn 2 ${two.status}`);
  },

  async stop() {
    const first = await turn("codex", "Run `sleep 120` in the shell, then say finished.");
    const record = await startRecorder("stop", first);
    await eventOf(first, "t3.activity.tool.updated");
    await api(`/api/runs/${first}/cancel`, {});
    const run = await settled(first, 90_000);
    await record();
    // A stopped run ends failed with the stop as its reason (runs have no cancelled status).
    check("stop", run.status === "failed" && run.summary === "Stopped by user",
      `run ${run.status} "${String(run.summary ?? "").slice(0, 160)}" after a stop during the tool call`);
  },

  async restart() {
    const first = await turn("codex", "Reply with the word alpha.");
    const record = await startRecorder("restart", first);
    const one = await settled(first);
    // Between turns: the thread continues on a fresh backend.
    await stop(stack.backend);
    stack.backend = await startService("backend", "src/index.ts", PORT, stack.env);
    const second = await turn("codex", "Run `sleep 20` in the shell, then reply with the word beta.", { parent_run_id: first });
    // During a turn: boot recovery re-attaches to the run the runtime still has.
    await eventOf(second, "t3.activity.tool.updated");
    await stop(stack.backend);
    stack.backend = await startService("backend", "src/index.ts", PORT, stack.env);
    const two = await settled(second);
    await record();
    check("restart", one.status === "completed" && two.status === "completed",
      `turn 1 ${one.status}; turn 2 across a mid-turn restart ${two.status} "${String(two.summary ?? "").slice(0, 40)}"`);
  },
};

const stack: { env: Record<string, string>; backend: Proc | null; gateway: Proc | null; tunnel: PublicTunnel | null } = {
  env: {}, backend: null, gateway: null, tunnel: null,
};

/** The tail of each runtime trace the failed scenario's sandboxes hold (still alive before teardown). */
async function saveRuntimeTraces(name: string): Promise<void> {
  for (const id of await labelledSandboxes(new Set(scenarioRuns))) {
    const sandbox = await Sandbox.connect(id, e2b);
    const trace = await sandbox.commands.run(
      `for home in /root /home/user; do f=$home/${SANDBOX_STATE_DIR}/t3/userdata/logs/server.trace.ndjson; [ -f $f ] && tail -c 600000 $f; done`,
      { user: "root", timeoutMs: 30_000 },
    );
    const path = `${LOG_DIR}/${name}-${id}.trace.ndjson`;
    writeFileSync(path, trace.stdout, { mode: 0o600 });
    console.log(`  runtime trace -> ${path}`);
  }
}

/**
 * Deletes every sandbox one of this database's runs used, found by its run
 * label, and checks each is gone. Runs after the backend stopped; a create the
 * provider was still finishing lands within the second sweep's wait.
 */
async function cleanupSandboxes(): Promise<void> {
  const runIds = new Set((await sql`select id from runs`.catch(() => [])).map((row) => String(row.id)));
  for (const sweep of [1, 2]) {
    if (sweep === 2) await sleep(30_000);
    for (const id of await labelledSandboxes(runIds)) {
      await Sandbox.kill(id, e2b).catch((error: Error) => console.log(`  delete ${id}: ${error.message}`));
      const status = (await fetch(`${e2b.apiUrl}/sandboxes/${id}`, { headers: { "X-API-Key": e2b.apiKey } })).status;
      console.log(`  sandbox ${id} ${status === 404 ? "deleted (API-verified 404)" : `STILL PRESENT (${status})`}`);
    }
  }
}

async function main(): Promise<void> {
  if (!TEMPLATE) throw new Error("V2_E2E_TEMPLATE is required");
  // `boot` only brings the stack up and down: a check of the harness itself.
  const args = process.argv.slice(2);
  const wanted = (args[0] === "boot" ? [] : args.length ? args
    : ALL.filter((name) => name !== "question" || creds.ANTHROPIC_API_KEY)) as Scenario[];
  for (const name of wanted) if (!ALL.includes(name)) throw new Error(`unknown scenario ${name}`);
  mkdirSync(LOG_DIR, { recursive: true });
  console.log(`V2 driver live proof: template ${TEMPLATE}, scenarios ${wanted.join(" ")}, database ${DB}`);
  await recreateDb();
  try {
    stack.tunnel = await startPublicTunnel({
      localPort: GATEWAY_PORT, logPath: `${LOG_DIR}/tunnel.log`, provider: tunnelProviderOrder(process.env.E2E_TUNNEL_PROVIDER)[0]!,
    });
    console.log(`  tunnel ${stack.tunnel.publicUrl}`);
    stack.env = stackEnv(stack.tunnel.publicUrl);
    // The backend's boot migrator builds the schema the gateway reads.
    stack.backend = await startService("backend", "src/index.ts", PORT, stack.env);
    stack.gateway = await startService("gateway", "src/gateway.ts", GATEWAY_PORT, stack.env);
    const probe = await createRun({ prompt: "database probe", engine: "mock" });
    if ((await sql`select 1 from runs where id = ${probe}`).length !== 1) throw new Error("the backend is not on the throwaway database");
    for (const name of wanted) {
      console.log(`\n-- ${name} --`);
      scenarioRuns = [];
      await scenarios[name]().catch((error: Error) => check(name, false, error.message));
      if (results.at(-1)?.status === "FAIL") await saveRuntimeTraces(name).catch((error: Error) => console.log(`  trace not saved: ${error.message}`));
    }
  } finally {
    console.log("\n-- teardown --");
    // The backend stops first, so nothing starts a sandbox while they are swept.
    await stop(stack.backend);
    await cleanupSandboxes().catch((error: Error) => console.log(`  sandbox cleanup failed: ${error.message}`));
    await stop(stack.gateway);
    if (stack.tunnel) await import("./lib/process-lifecycle").then(({ stopOwnedProcess }) => stopOwnedProcess(stack.tunnel!.process));
    // V2_E2E_KEEP_DB=1 keeps the database for a look at a failure (drop it by hand after).
    if (process.env.V2_E2E_KEEP_DB === "1") await sql.end().catch(() => {});
    else await dropDb();
  }
  console.log("\n-- results --");
  for (const result of results) console.log(`  ${result.status} ${result.scenario.padEnd(9)} ${result.detail}`);
  writeFileSync(`${LOG_DIR}/results.json`, JSON.stringify(results, null, 2));
  process.exit(results.some((result) => result.status === "FAIL") ? 1 : 0);
}

await main();
