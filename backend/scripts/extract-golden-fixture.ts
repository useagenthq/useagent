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

const rows = (await sql`
  SELECT seq, provider, event_type, native_session_id, native_parent_session_id,
         native_message_id, native_part_id, native_call_id, payload
  FROM provider_events
  WHERE run_id = (SELECT id FROM runs WHERE id LIKE ${`${runPrefix}%`} LIMIT 1)
  ORDER BY seq ASC`) as unknown as Row[];
await sql.end();

if (rows.length === 0) throw new Error(`no provider_events for run ${runPrefix}`);

// --- collect sensitive source strings for the post-scan (before we drop them) ---
const sensitive = new Set<string>();
const addSensitive = (v: unknown) => {
  if (typeof v === "string" && v.trim().length >= 4) sensitive.add(v);
};
const walk = (v: unknown) => {
  if (typeof v === "string") addSensitive(v);
  else if (Array.isArray(v)) for (const x of v) walk(x);
  else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
};
for (const r of rows) walk(r.payload);

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

// --- provable-clean scan: no sensitive source string may survive ---
const serialized = JSON.stringify(frames);
const leaks: string[] = [];
for (const s of sensitive) {
  // ignore short structural tokens that legitimately recur (tool names, states)
  if (s.length < 6) continue;
  if (serialized.includes(s)) leaks.push(s.slice(0, 40));
  if (leaks.length >= 5) break;
}
if (leaks.length > 0) {
  throw new Error(`SANITIZATION FAILED - sensitive strings survived: ${JSON.stringify(leaks)}`);
}

await Bun.write(outPath, `${JSON.stringify(frames, null, 2)}\n`);
console.log(
  `[golden] wrote ${frames.length} sanitized frames -> ${outPath} | ids remapped: ` +
    `${maps.ses.size} ses, ${maps.msg.size} msg, ${maps.call.size} call | scanned ${sensitive.size} source strings, 0 leaks`,
);
