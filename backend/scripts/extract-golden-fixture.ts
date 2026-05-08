/**
 * Sanitizing golden-fixture extractor (final_harness.md Phase 0).
 *
 * Reads ONE real OpenCode run's provider_events and emits a STRUCTURE-ONLY
 * NativeFrame[] fixture the frontend derivation (timeline.ts / native-events.ts)
 * can be golden-tested against - with ZERO customer data. Every id is remapped to
 * a synthetic sequential handle; every free-text payload (message text, tool
 * output, file content, paths, prompts, urls, repo names) is replaced with a fixed
 * placeholder. Only the structural skeleton survives: eventType, part/tool kind,
 * tool name, state.status, and the `<task id="ses_N">`/`<task_result>` markers the
 * child-derivation regexes key on (with the child id itself remapped).
 *
 * After building, it SCANS the serialized fixture for every sensitive source
 * string (the run's prompt + every original payload text/output/path) and throws
 * if any survived - so a committed fixture is provably clean.
 *
 * Run:  bun scripts/extract-golden-fixture.ts <runIdPrefix> <outPath>
 * (one-time generation; the OUTPUT fixture is committed, this script is the tool.)
 */
import postgres from "postgres";

const runPrefix = process.argv[2] ?? "33fbc260";
const outPath = process.argv[3] ?? "../frontend/components/chat/__fixtures__/opencode-heavy.json";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/skynet", { max: 1 });

interface Row {
  seq: number;
  provider: string | null;
  event_type: string;
  native_session_id: string | null;
  native_parent_session_id: string | null;
  native_message_id: string | null;
  native_part_id: string | null;
  native_call_id: string | null;
  payload: unknown;
}

interface StepRow {
  idx: number;
  kind: string;
  label: string | null;
  chip: string | null;
  code_json: string | null;
}

// The run's own free-text columns are the single richest source of customer data
// (the task prompt, the model's summary, repo names, error text). We MUST add them
// to the sensitive set the post-scan checks against - the fixture only ever draws
// from provider_events/steps, but a leak there could echo the prompt verbatim.
interface RunMetaRow {
  prompt: string | null;
  summary: string | null;
  repo: string | null;
  repos: unknown;
}

const rows = (await sql`
  SELECT seq, provider, event_type, native_session_id, native_parent_session_id,
         native_message_id, native_part_id, native_call_id, payload
  FROM provider_events
  WHERE run_id = (SELECT id FROM runs WHERE id LIKE ${`${runPrefix}%`} LIMIT 1)
  ORDER BY seq ASC`) as unknown as Row[];
const stepRows = (await sql`
  SELECT idx, kind, label, chip, code_json
  FROM steps
  WHERE run_id = (SELECT id FROM runs WHERE id LIKE ${`${runPrefix}%`} LIMIT 1)
  ORDER BY idx ASC`) as unknown as StepRow[];
const metaRows = (await sql`
  SELECT prompt, summary, repo, repos
  FROM runs WHERE id LIKE ${`${runPrefix}%`} LIMIT 1`) as unknown as RunMetaRow[];
await sql.end();

if (rows.length === 0) throw new Error(`no provider_events for run ${runPrefix}`);

// --- collect sensitive source strings for the post-scan (before we drop them) ---
const sensitive = new Set<string>();
const addSensitive = (v: unknown) => {
  // 3-char floor: catch short identifiers (repo/company codes) while excluding
  // 1-2 char strings that are non-identifying and would collide with everything.
  if (typeof v === "string" && v.trim().length >= 3) sensitive.add(v);
};
const walk = (v: unknown) => {
  if (typeof v === "string") addSensitive(v);
  else if (Array.isArray(v)) for (const x of v) walk(x);
  else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
};
for (const r of rows) walk(r.payload);
if (metaRows[0]) walk(metaRows[0]); // prompt + summary + repo(s) + error + source_repo
for (const s of stepRows) {
  addSensitive(s.label);
  addSensitive(s.chip);
  if (s.code_json) {
    try {
      walk(JSON.parse(s.code_json));
    } catch {
      addSensitive(s.code_json);
    }
  }
}

// --- id remap: real -> synthetic stable handle, preserving relationships ---
const maps = { ses: new Map<string, string>(), msg: new Map<string, string>(), prt: new Map<string, string>(), call: new Map<string, string>() };
const remap = (kind: keyof typeof maps, real: string | null): string | null => {
  if (!real) return null;
  const m = maps[kind];
  if (!m.has(real)) m.set(real, `${kind === "ses" ? "ses" : kind}_${m.size + 1}`);
  return m.get(real) as string;
};
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// --- sanitize one payload into a structural skeleton (no content) ---
const TASK_CHILD_ID = /<task\s+id="(ses_[^"]+)"/;
function sanitizePayload(eventType: string, payload: unknown): unknown {
  const p = asRecord(payload);
  if (!p) return {};
  // tool part: keep type/tool/state.status; rebuild state.output with remapped
  // task markers only (child id + a placeholder result), never the real output.
  if (p.type === "tool") {
    const state = asRecord(p.state);
    let output = "";
    if (p.tool === "task" && state) {
      const realOut = typeof state.output === "string" ? state.output : "";
      const childReal = TASK_CHILD_ID.exec(realOut)?.[1] ?? null;
      const childSyn = remap("ses", childReal);
      if (childSyn) output = `<task id="${childSyn}"><task_result>REDACTED</task_result></task>`;
    }
    return {
      type: "tool",
      tool: typeof p.tool === "string" ? p.tool : "tool",
      state: { status: state && typeof state.status === "string" ? state.status : "completed", output },
    };
  }
  // text part: fixed placeholder so lastTextBySession has deterministic content.
  if (eventType.startsWith("part.text")) return { type: "text", text: "REDACTED_TEXT" };
  // everything else: keep only the discriminant type, drop all content.
  return typeof p.type === "string" ? { type: p.type } : {};
}

const frames = rows.map((r, i) => ({
  schemaVersion: 1,
  eventId: `evt_${i}`,
  seq: i,
  provider: r.provider ?? "opencode",
  eventType: r.event_type,
  native: {
    sessionId: remap("ses", r.native_session_id),
    parentSessionId: remap("ses", r.native_parent_session_id),
    messageId: remap("msg", r.native_message_id),
    partId: remap("prt", r.native_part_id),
    callId: remap("call", r.native_call_id),
  },
  payload: sanitizePayload(r.event_type, r.payload),
}));

// --- sanitize one step's code_json: keep the real `tool` (so deriveTrace renders it
//     as a tool ROW, not narration) + remapped native ids (so it orders against the
//     frames via partID), redact all content. Shares the frame id maps. ---
function sanitizeStepCode(codeStr: string | null): string | null {
  if (!codeStr) return null;
  let code: Record<string, unknown> | null = null;
  try {
    code = asRecord(JSON.parse(codeStr));
  } catch {
    return null;
  }
  if (!code) return null;
  const n = asRecord(code.native);
  const out: Record<string, unknown> = { output: "" };
  if (typeof code.tool === "string") out.tool = code.tool;
  if (typeof code.type === "string") out.type = code.type;
  if (code.error === true) out.error = true;
  if (n) {
    out.native = {
      sessionID: remap("ses", (n.sessionID as string | null) ?? null) ?? undefined,
      messageID: remap("msg", (n.messageID as string | null) ?? null) ?? undefined,
      partID: remap("prt", (n.partID as string | null) ?? null) ?? undefined,
      callID: remap("call", (n.callID as string | null) ?? null) ?? undefined,
      childSessionID: remap("ses", (n.childSessionID as string | null) ?? null) ?? undefined,
    };
  }
  return JSON.stringify(out);
}

const steps = stepRows.map((s, i) => ({
  id: `step_${i}`,
  run_id: "run_fixture",
  idx: typeof s.idx === "number" ? s.idx : i,
  kind: s.kind,
  label: "REDACTED",
  chip: null,
  code_json: sanitizeStepCode(s.code_json),
  created_at: "2026-01-01T00:00:00.000Z",
}));

// Controlled vocabulary the fixture INTENTIONALLY emits, none of it customer data:
//   (a) fixture-own tokens: synthetic id prefixes (ses_/msg_/prt_/call_/evt_/step_),
//       placeholders, the fixed timestamp, and the task-marker literals; plus
//   (b) opencode's fixed structural tokens (provider, event types, tool names,
//       state.status, part/step type discriminants, step kinds) collected from the
//       source's structural FIELDS below.
// A sensitive source string equal to (or a substring of) one of these is not a leak,
// so we exclude them - and ONLY these. Everything else in `sensitive` is scanned at
// every length (no <6 exception): the exclusion set is provably controlled vocabulary,
// so we no longer need a length heuristic to suppress structural-token false positives.
const structural = new Set<string>([
  "opencode", "skynet", "tool", "text", "completed", "error", "running", "pending",
  "REDACTED", "REDACTED_TEXT", "run_fixture", "2026-01-01T00:00:00.000Z",
  // synthetic id prefixes (remapped handles are `<prefix>_<n>`) + task markers
  "ses", "msg", "prt", "call", "evt", "step", "run", "task", "task_result",
]);
for (const r of rows) {
  if (r.provider) structural.add(r.provider);
  structural.add(r.event_type);
  const p = asRecord(r.payload);
  if (p) {
    if (typeof p.type === "string") structural.add(p.type);
    if (typeof p.tool === "string") structural.add(p.tool);
    const st = asRecord(p.state);
    if (st && typeof st.status === "string") structural.add(st.status);
  }
}
for (const s of stepRows) {
  structural.add(s.kind);
  try {
    const c = asRecord(JSON.parse(s.code_json ?? "{}"));
    if (c) {
      if (typeof c.tool === "string") structural.add(c.tool);
      if (typeof c.type === "string") structural.add(c.type);
    }
  } catch {}
}
for (const k of structural) sensitive.delete(k);

// --- provable-clean scan: no sensitive source string may survive in any output VALUE.
// We scan string VALUES only (not JSON keys): keys are our own fixed field names
// (type/tool/status/native/...), and folding them into the blob is exactly what forced
// the old <6-char skip - a customer string that happened to equal a field name would
// false-positive. Scanning values against the controlled-vocabulary exclusion set lets
// us check EVERY sensitive string at EVERY length. ---
const outputValues: string[] = [];
const collectValues = (v: unknown) => {
  if (typeof v === "string") outputValues.push(v);
  else if (Array.isArray(v)) for (const x of v) collectValues(x);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectValues(x);
};
for (const f of frames) collectValues(f);
for (const s of steps) collectValues(s);
const valueBlob = outputValues.join(" ");
const leaks: string[] = [];
for (const s of sensitive) {
  if (valueBlob.includes(s)) leaks.push(s.slice(0, 40));
  if (leaks.length >= 5) break;
}
if (leaks.length > 0) {
  throw new Error(`SANITIZATION FAILED - sensitive strings survived: ${JSON.stringify(leaks)}`);
}

const stepsOutPath = outPath.replace(/\.json$/, "-steps.json");
await Bun.write(outPath, `${JSON.stringify(frames, null, 2)}\n`);
await Bun.write(stepsOutPath, `${JSON.stringify(steps, null, 2)}\n`);
console.log(
  `[golden] wrote ${frames.length} frames -> ${outPath} + ${steps.length} steps -> ${stepsOutPath} | ` +
    `ids remapped: ${maps.ses.size} ses, ${maps.msg.size} msg, ${maps.call.size} call | ` +
    `scanned ${sensitive.size} source strings, 0 leaks`,
);
