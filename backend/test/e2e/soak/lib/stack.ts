/**
 * Shared soak infrastructure: an isolated backend STACK — throwaway Postgres DB,
 * a real `bun src/index.ts` subprocess, and in-process mock Memory/Slack
 * receivers with optional fault injection. Modeled on test/e2e/full-stack.ts but
 * reusable across storms and built for repeated kill/restart cycles.
 *
 * A stack is fully self-contained on its own ports + DB, so storms never collide
 * with each other or with other agents' backends (ports 3501-3515). The soak
 * suite deliberately takes 3516+.
 */
import postgres from "postgres";
import { createHmac } from "node:crypto";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const backendDir = new URL("../../../..", import.meta.url).pathname; // → backend/

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── mock receiver with fault injection ────────────────────────────────────────

export interface Hit {
  path: string;
  method: string;
  body: any;
  at: number;
}

/** A fault policy: given the request count so far, decide the HTTP response. A
 *  `delayMs` holds the response open that long (simulates an in-flight call that a
 *  SIGKILL can orphan mid-delivery). */
export type FaultFn = (n: number, hit: Hit) => { status: number; body?: any; headers?: Record<string, string>; delayMs?: number } | null;

export class MockReceiver {
  readonly hits: Hit[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private n = 0;
  constructor(
    readonly port: number,
    /** Fault policy; return null to fall through to the default 200 OK body. */
    private fault: FaultFn | null,
    /** Default success body for a path (memory search needs a canned result). */
    private defaultBody: (hit: Hit) => any = () => ({ ok: true }),
  ) {}

  start(): void {
    this.server = Bun.serve({
      port: this.port,
      fetch: async (req) => {
        const url = new URL(req.url);
        const hit: Hit = {
          path: url.pathname,
          method: req.method,
          body: await req.json().catch(() => ({})),
          at: Date.now(),
        };
        this.hits.push(hit);
        const n = ++this.n;
        const f = this.fault?.(n, hit) ?? null;
        if (f) {
          if (f.delayMs) await sleep(f.delayMs); // hold the response open (orphanable in-flight)
          return new Response(f.body !== undefined ? JSON.stringify(f.body) : "", {
            status: f.status,
            headers: { "content-type": "application/json", ...(f.headers ?? {}) },
          });
        }
        return Response.json(this.defaultBody(hit));
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  /** Reset recorded hits + fault counter (between rounds). */
  reset(): void {
    this.hits.length = 0;
    this.n = 0;
  }

  setFault(f: FaultFn | null): void {
    this.fault = f;
  }
}

// ── subprocess backend ────────────────────────────────────────────────────────

export type Proc = ReturnType<typeof Bun.spawn>;

export interface StackConfig {
  db: string; // throwaway DB name
  port: number;
  memPort?: number;
  slackPort?: number;
  signingSecret?: string;
  /** ms per mock worker step — small = fast volume, larger = catchable mid-run. */
  stepDelayMs?: number;
  extraEnv?: Record<string, string>;
  /** Silence child stdio (default) or inherit for debugging. */
  debug?: boolean;
}

export class Stack {
  readonly dbUrl: string;
  readonly base: string;
  readonly sql: ReturnType<typeof postgres>;
  proc: Proc | null = null;
  readonly mem: MockReceiver | null;
  readonly slack: MockReceiver | null;
  readonly signingSecret: string;

  constructor(readonly cfg: StackConfig) {
    this.dbUrl = `postgres://postgres@localhost:5432/${cfg.db}`;
    this.base = `http://localhost:${cfg.port}`;
    this.sql = postgres(this.dbUrl, { max: 6 });
    this.signingSecret = cfg.signingSecret ?? "soak-signing-secret";
    this.mem = cfg.memPort
      ? new MockReceiver(cfg.memPort, null, (hit) =>
          hit.path === "/v3/atomic/search"
            ? { code: 0, data: { items: [{ id: "canary-1", type: "fact", content: "soak canary", score: 0.98 }] } }
            : { code: 0, data: {} },
        )
      : null;
    this.slack = cfg.slackPort ? new MockReceiver(cfg.slackPort, null, () => ({ ok: true })) : null;
  }

  async recreateDb(): Promise<void> {
    const admin = postgres(ADMIN_URL, { max: 1 });
    try {
      await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${this.cfg.db} AND pid <> pg_backend_pid()`.catch(() => {});
      await admin.unsafe(`DROP DATABASE IF EXISTS ${this.cfg.db}`);
      await admin.unsafe(`CREATE DATABASE ${this.cfg.db}`);
    } finally {
      await admin.end();
    }
  }

  private env(): Record<string, string> {
    const e: Record<string, string> = {
      ...process.env,
      PORT: String(this.cfg.port),
      DATABASE_URL: this.dbUrl,
      FRONTEND_ORIGIN: "http://localhost:3400",
      WORKER_STEP_DELAY_MS: String(this.cfg.stepDelayMs ?? 4),
      // Never let a real engine or real external service get pulled in.
      SLACK_DEFAULT_ENGINE: "mock",
      ...(this.cfg.extraEnv ?? {}),
    };
    if (this.mem) {
      e.MEMORY_API_URL = `http://localhost:${this.mem.port}`;
      e.MEMORY_API_KEY = "soak";
      e.MEMORY_TEAM_ID = "skynet";
      e.MEMORY_AGENT_ID = "skynet-backend";
      e.MEMORY_USER_ID = "skynet";
      e.MEMORY_OUTBOX_TICK_MS = e.MEMORY_OUTBOX_TICK_MS ?? "300";
    } else {
      delete e.MEMORY_API_URL;
    }
    if (this.slack) {
      e.SLACK_BOT_TOKEN = "xoxb-soak";
      e.SLACK_SIGNING_SECRET = this.signingSecret;
      e.SLACK_API_URL = `http://localhost:${this.slack.port}`;
      e.SLACK_OUTBOX_TICK_MS = e.SLACK_OUTBOX_TICK_MS ?? "300";
      e.SLACK_OUTBOX_BASE_MS = e.SLACK_OUTBOX_BASE_MS ?? "40";
    }
    return e;
  }

  /** Start (or restart) the backend subprocess; resolves once /api/health is up. */
  async start(label = "boot", timeoutMs = 45_000): Promise<void> {
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: backendDir,
      env: this.env(),
      stdout: this.cfg.debug ? "inherit" : "ignore",
      stderr: this.cfg.debug ? "inherit" : "ignore",
    });
    this.proc = proc;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${this.base}/api/health`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await sleep(150);
    }
    throw new Error(`[${label}] backend did not come up on :${this.cfg.port}`);
  }

  /** SIGKILL — no graceful shutdown, exactly like a crash. */
  async kill(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill(9);
    await this.proc.exited;
    this.proc = null;
    // Reap the dead backend's orphaned connections to THIS throwaway DB. A SIGKILL
    // leaves its pool's sockets held until Postgres notices the broken pipe; rapid
    // kill/restart cycles would otherwise pile up toward max_connections and make a
    // later boot's first query 500. Scoped strictly to this.cfg.db — never touches
    // another agent's database. My own this.sql pool (idle here) just reconnects.
    const admin = postgres(ADMIN_URL, { max: 1 });
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${this.cfg.db} and pid <> pg_backend_pid()`.catch(() => {});
    await admin.end();
  }

  startReceivers(): void {
    this.mem?.start();
    this.slack?.start();
  }

  /** Full teardown: kill backend, stop receivers, drop DB, close pools. */
  async teardown(): Promise<void> {
    await this.kill().catch(() => {});
    this.mem?.stop();
    this.slack?.stop();
    await this.sql.end().catch(() => {});
    const admin = postgres(ADMIN_URL, { max: 1 });
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${this.cfg.db} AND pid <> pg_backend_pid()`.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${this.cfg.db}`).catch(() => {});
    await admin.end();
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────────

  async postRun(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; id?: string; error?: string }> {
    const res = await fetch(`${this.base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    return { status: res.status, id: j.id, error: j.error };
  }

  slackHeaders(raw: string): Record<string, string> {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = "v0=" + createHmac("sha256", this.signingSecret).update(`v0:${ts}:${raw}`).digest("hex");
    return { "content-type": "application/json", "x-slack-signature": sig, "x-slack-request-timestamp": ts };
  }

  async postSlackEvent(event: Record<string, unknown>, bot = "U0SOAKBOT"): Promise<void> {
    const raw = JSON.stringify({
      type: "event_callback",
      event_id: `Ev${crypto.randomUUID().slice(0, 10)}`,
      authorizations: [{ user_id: bot }],
      event,
    });
    await fetch(`${this.base}/api/slack/events`, { method: "POST", body: raw, headers: this.slackHeaders(raw) });
  }
}

/** Poll a predicate until true or the budget elapses. */
export async function waitFor(fn: () => Promise<boolean>, budgetMs = 15_000, intervalMs = 60): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}
