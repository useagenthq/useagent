/**
 * Fleet 20-task hosted canary (HA Stage A). Submits N tasks concurrently against
 * a DEPLOYED backend and reports real p50/p95 for submission / queue-wait /
 * completion, plus the peak durable-queue depth and any 429 quota rejections.
 *
 * DEFERRED EXECUTION — like the #34 fleet-dispatch live E2E, this needs a live
 * host + a valid session, so it is run POST-MERGE / POST-DEPLOY, not in CI. The
 * deterministic in-test equivalent (real numbers even before the hosted run) is
 * `backend/test/fleet-admission.test.ts`.
 *
 * Usage:
 *   USEAGENT_BASE_URL=https://<host> \
 *   FLEET_CANARY_COOKIE="__Secure-better-auth.session_token=..." \
 *   [FLEET_CANARY_TASKS=20] [FLEET_CANARY_ENGINE=mock] \
 *   bun run backend/test/e2e/fleet-canary.ts
 *
 * Auth: provide the org session as a raw Cookie header in FLEET_CANARY_COOKIE, or
 * a path to a file containing it in FLEET_CANARY_COOKIE_FILE. (When org API keys
 * (#33) land, pass `Authorization: Bearer <key>` via FLEET_CANARY_BEARER instead.)
 */
import { readFile } from "node:fs/promises";

const baseUrl = new URL(process.env.USEAGENT_BASE_URL ?? "https://skynet.meow.gs");
const tasks = Number(process.env.FLEET_CANARY_TASKS ?? 20);
const engine = process.env.FLEET_CANARY_ENGINE ?? "mock";
const timeoutMs = Number(process.env.FLEET_CANARY_TIMEOUT_MS ?? 600_000);
const bearer = process.env.FLEET_CANARY_BEARER?.trim();

async function resolveCookie(): Promise<string> {
  if (process.env.FLEET_CANARY_COOKIE) return process.env.FLEET_CANARY_COOKIE.trim();
  if (process.env.FLEET_CANARY_COOKIE_FILE) {
    return (await readFile(process.env.FLEET_CANARY_COOKIE_FILE, "utf8")).trim();
  }
  return "";
}
const cookie = await resolveCookie();
if (!cookie && !bearer) {
  throw new Error(
    "auth required: set FLEET_CANARY_COOKIE (or _FILE) to an org session, or FLEET_CANARY_BEARER",
  );
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { origin: baseUrl.origin };
  if (cookie) h.cookie = cookie;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  return h;
}

async function post<T>(path: string, body: unknown, key?: string): Promise<{ status: number; body: T }> {
  const headers = new Headers({ ...authHeaders(), "content-type": "application/json" });
  if (key) headers.set("idempotency-key", key);
  const res = await fetch(new URL(path, baseUrl), { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(new URL(path, baseUrl), { headers: new Headers(authHeaders()) });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
const fmt = (v: number[]) => `p50=${percentile(v, 50)}ms p95=${percentile(v, 95)}ms n=${v.length}`;

interface RunResponse {
  id: string;
  status?: string;
  queue?: { state: string; reason: string | null; position: number } | null;
}

// 1. Submit N tasks concurrently — one thread each.
const submissionMs: number[] = [];
const accepted: RunResponse[] = [];
let quota429 = 0;
const started = new Map<string, number>();
await Promise.all(
  Array.from({ length: tasks }, async (_v, i) => {
    const t0 = Date.now();
    const r = await post<RunResponse>(
      "/api/runs",
      { prompt: `fleet canary task ${i}`, engine },
      `fleet-canary:${crypto.randomUUID()}`,
    );
    const dt = Date.now() - t0;
    if (r.status === 429) {
      quota429 += 1;
      return;
    }
    if (r.status !== 201 && r.status !== 200) {
      throw new Error(`submit ${i}: unexpected HTTP ${r.status}`);
    }
    submissionMs.push(dt);
    accepted.push(r.body);
    started.set(r.body.id, t0);
  }),
);

// 2. Snapshot the durable queue right after the burst.
const cap = await get<{
  org?: { activeSandboxes: number; queued: number; maxActiveSandboxes: number };
  global?: { activeSandboxes: number; maxActiveSandboxes: number };
}>("/api/fleet/capacity");
const peakQueued = cap.body?.org?.queued ?? 0;
const queuedAtSubmit = accepted.filter((r) => r.status === "queued" || r.queue?.state === "queued").length;

// 3. Poll each accepted run to terminal; measure completion wall time.
const completionMs: number[] = [];
const deadline = Date.now() + timeoutMs;
const pending = new Set(accepted.map((r) => r.id));
while (pending.size > 0 && Date.now() < deadline) {
  for (const id of [...pending]) {
    const r = await get<{ status?: string }>(`/api/runs/${id}`);
    if (r.body?.status === "completed" || r.body?.status === "failed") {
      completionMs.push(Date.now() - (started.get(id) ?? Date.now()));
      pending.delete(id);
    }
  }
  if (pending.size > 0) await Bun.sleep(1_000);
}

// 4. Report.
console.log("\n=== Fleet capacity canary report ===");
console.log(`host:            ${baseUrl.origin}`);
console.log(`tasks submitted: ${tasks} (engine=${engine})`);
console.log(`durably accepted:${accepted.length}   429 quota:${quota429}`);
console.log(`queued at submit:${queuedAtSubmit}   peak durable queue:${peakQueued}`);
console.log(`org sandboxes:   ${cap.body?.org?.activeSandboxes ?? "?"} / ${cap.body?.org?.maxActiveSandboxes ?? "?"}`);
console.log(`host sandboxes:  ${cap.body?.global?.activeSandboxes ?? "?"} / ${cap.body?.global?.maxActiveSandboxes ?? "?"}`);
console.log(`submission:      ${fmt(submissionMs)}`);
console.log(`completion:      ${fmt(completionMs)}`);
console.log(`reached terminal:${completionMs.length}/${accepted.length}`);
console.log("====================================\n");

if (completionMs.length < accepted.length) {
  throw new Error(`canary: ${accepted.length - completionMs.length} task(s) never reached a terminal state`);
}
