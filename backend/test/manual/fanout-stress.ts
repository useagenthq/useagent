/**
 * MANUAL fanout stress driver (north star Fanout: "test 5 and 20 interleaved
 * child agents"). NOT part of `bun test` — it needs a live backend + Daytona.
 *
 * Usage (against a backend already listening on $PORT, sharing $DATABASE_URL):
 *   PORT=3506 DATABASE_URL=... bun run test/manual/fanout-stress.ts run 5
 *   PORT=3506 DATABASE_URL=... bun run test/manual/fanout-stress.ts inspect <runId>
 *
 * `run N` POSTs a run that asks opencode to fan out N subagents, polls to a
 * terminal state, then inspects. `inspect <id>` just runs the DB assertions
 * (used after a kill/restart recovery). Findings print as a JSON block prefixed
 * FANOUT_FINDINGS= so the orchestrator can grep them.
 */
import postgres from "postgres";

const PORT = process.env.PORT ?? "3506";
const BASE = `http://localhost:${PORT}`;
const DB = process.env.DATABASE_URL!;
const sql = postgres(DB, { max: 2 });

function fanoutPrompt(n: number): string {
  return (
    `You have a \`task\` tool that launches subagents. Launch exactly ${n} subagents, ` +
    `all at once (in parallel), and delegate one unit of work to each — do NOT do the ` +
    `work yourself. Each subagent i (1..${n}) writes a single distinct 3-line haiku into ` +
    `its own file haiku_i.txt (nothing else). When all ${n} have finished, reply "DONE" ` +
    `with the list of files created. Keep every subagent's work trivial.`
  );
}

async function post(prompt: string): Promise<string> {
  const res = await fetch(`${BASE}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, engine: "opencode", model: "claude-opus-5" }),
  });
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error(`no run id: ${JSON.stringify(body)}`);
  return body.id;
}

async function getRun(id: string): Promise<{ status: string; engine_session_id: string | null; steps: number }> {
  const res = await fetch(`${BASE}/api/runs/${id}`);
  const r = (await res.json()) as any;
  return { status: r.status, engine_session_id: r.engine_session_id ?? null, steps: r.steps?.length ?? 0 };
}

async function pollTerminal(id: string, budgetMs: number): Promise<string> {
  const deadline = Date.now() + budgetMs;
  let last = "";
  while (Date.now() < deadline) {
    const r = await getRun(id);
    if (r.status !== last) {
      last = r.status;
    }
    if (r.status === "completed" || r.status === "failed") return r.status;
    await new Promise((res) => setTimeout(res, 3000));
  }
  return "timeout";
}

/** Wait until the run is running with a native session id AND at least one child
 *  session is registered (for the mid-fanout kill test). Returns the parent id. */
async function waitForFanoutInFlight(id: string, budgetMs: number): Promise<{ parent: string | null; children: number }> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const r = await getRun(id);
    const children = await childCount(id);
    if (r.engine_session_id && children >= 1) return { parent: r.engine_session_id, children };
    if (r.status === "completed" || r.status === "failed") return { parent: r.engine_session_id, children };
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { parent: null, children: 0 };
}

async function childCount(runId: string): Promise<number> {
  const rows = await sql`
    select count(distinct native_session_id)::int as n
    from provider_events
    where run_id = ${runId} and native_parent_session_id is not null`;
  return rows[0]?.n ?? 0;
}

async function inspect(runId: string): Promise<Record<string, unknown>> {
  const run = await getRun(runId);

  // Children = distinct native sessions that carry a parent linkage.
  const children = await sql`
    select native_session_id as child, native_parent_session_id as parent
    from provider_events
    where run_id = ${runId} and native_parent_session_id is not null
    group by native_session_id, native_parent_session_id`;

  // Parent linkage: every child's parent is either the run's parent session or
  // another registered child (grandchild). Report any orphan (parent unknown).
  const known = new Set<string>([run.engine_session_id ?? ""]);
  for (const c of children) known.add(c.child as string);
  const orphans = children.filter((c) => !known.has(c.parent as string));

  // provider_events totals + payload-cap markers.
  const [{ total }] = await sql`select count(*)::int as total from provider_events where run_id = ${runId}`;
  const [{ capped }] = await sql`
    select count(*)::int as capped from provider_events
    where run_id = ${runId} and length(payload) >= 32768`;

  // Steps + duplicate detection: a native partID must map to exactly ONE step
  // row (running→completed is an in-place update on the same row). Two step rows
  // sharing a partID = the enqueuePart serialization failed under load.
  const steps = await sql`select id, code_json from steps where run_id = ${runId}`;
  const partToSteps = new Map<string, Set<string>>();
  for (const s of steps as { id: string; code_json: string | null }[]) {
    if (!s.code_json) continue;
    let partId: string | undefined;
    try {
      partId = JSON.parse(s.code_json)?.native?.partID ?? undefined;
    } catch {
      /* non-JSON code_json (bootstrap steps) — no native id */
    }
    if (!partId) continue;
    const set = partToSteps.get(partId) ?? new Set<string>();
    set.add(s.id);
    partToSteps.set(partId, set);
  }
  const duplicatedParts = [...partToSteps.entries()].filter(([, set]) => set.size > 1);

  return {
    runId,
    status: run.status,
    parentSession: run.engine_session_id,
    childrenRegistered: children.length,
    orphanChildren: orphans.length,
    providerEventsTotal: total,
    payloadCappedRows: capped,
    stepsTotal: steps.length,
    stepsWithNativePart: partToSteps.size,
    duplicatedNativeParts: duplicatedParts.length,
    duplicatedPartIds: duplicatedParts.map(([p]) => p).slice(0, 5),
  };
}

const [mode, arg] = process.argv.slice(2);
try {
  if (mode === "run") {
    const n = Number(arg);
    const t0 = Date.now();
    const id = await post(fanoutPrompt(n));
    console.log(`RUN ${id} (N=${n}) posted`);
    const status = await pollTerminal(id, 8 * 60_000);
    const elapsedMs = Date.now() - t0;
    const findings = { N: n, elapsedMs, ...(await inspect(id)) };
    console.log("FANOUT_FINDINGS=" + JSON.stringify(findings));
  } else if (mode === "run-until-inflight") {
    // POST + return once fanout is in-flight (for the kill test). Prints RID= and INFLIGHT=.
    const n = Number(arg);
    const id = await post(fanoutPrompt(n));
    console.log(`RID=${id}`);
    const s = await waitForFanoutInFlight(id, 90_000);
    console.log(`INFLIGHT=${JSON.stringify(s)}`);
  } else if (mode === "inspect") {
    console.log("FANOUT_FINDINGS=" + JSON.stringify(await inspect(arg!)));
  } else {
    console.error("usage: fanout-stress.ts run <N> | run-until-inflight <N> | inspect <runId>");
    process.exitCode = 2;
  }
} finally {
  await sql.end();
}
