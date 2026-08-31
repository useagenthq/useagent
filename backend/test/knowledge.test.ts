import { afterEach, beforeEach, beforeAll, describe, expect, test } from "bun:test";
import { createOrgSession, json, uid, type OrgSession } from "./helpers";
import { ingestOne } from "../src/knowledge/ingest";
import { findExisting, listRecords } from "../src/knowledge/store";

// Isolate this suite in its own authenticated org (real session, NOT a forged
// x-org-id header) so the boot seed / other suites never collide with our
// assertions. Tenancy is resolved server-side from the session cookie.
let session: OrgSession;
let H: { cookies: string };

const EXTERNAL_ID = "thread-42";
const CONNECTOR = "test:suite";
const TEXT =
  "Nightly ETL OOM\n\nThe nightly ETL job crashes with an OutOfMemory error " +
  "when the batch exceeds 10000 rows. Fix: raise the JVM heap to 4G in the " +
  "scheduler config and cap the batch size.";

function ingestBody() {
  return {
    meta: {
      source_type: "conversation",
      external_id: EXTERNAL_ID,
      connector_instance_id: CONNECTOR,
      domain: "engineering",
    },
    text: TEXT,
  };
}

describe("knowledge ingest → search", () => {
  let recordId: string;

  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  beforeAll(async () => {
    session = await createOrgSession("knowledge");
    H = { cookies: session.cookies };
  });

  test("ingest stub-distills and stores (LLM mocked → stub)", async () => {
    const { status, body } = await json<any>("/api/knowledge/ingest", {
      method: "POST",
      body: ingestBody(),
      ...H,
    });
    expect(status).toBe(200);
    expect(body.status).toBe("stored");
    expect(body.stub).toBe(true); // proves distillation ran the keyless stub path
    expect(body.kind).toBe("reference"); // the stub's fixed kind
    expect(body.worthSaving).toBe(true);
    expect(body.id).toBeTruthy();
    recordId = body.id;
  });

  test("re-ingest identical content is skipped (idempotent)", async () => {
    const { status, body } = await json<any>("/api/knowledge/ingest", {
      method: "POST",
      body: ingestBody(),
      ...H,
    });
    expect(status).toBe(200);
    expect(body.status).toBe("skipped");
    expect(body.id).toBe(recordId);
  });

  test("list returns the record; embeddings degraded to keyword-only", async () => {
    const { status, body } = await json<any>("/api/knowledge", H);
    expect(status).toBe(200);
    expect(body.embeddings).toBe(false); // no OPENAI_API_KEY → keyword-only
    const found = body.records.find((r: any) => r.id === recordId);
    expect(found).toBeDefined();
    expect(found.kind).toBe("reference");
    expect(found.domain).toBe("engineering");
    expect(found.visibility).toBe("internal"); // fail-closed default
  });

  test("search ranks the record and reports keyword mode", async () => {
    const { status, body } = await json<any>("/api/knowledge/search", {
      method: "POST",
      body: { query: "nightly ETL OOM", k: 5 },
      ...H,
    });
    expect(status).toBe(200);
    expect(body.mode).toBe("keyword");
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].id).toBe(recordId);
    expect(body.results[0].rank).toBe(1);
    expect(body.results[0].title).toBeTruthy();
  });

  test("pin then delete", async () => {
    const pinned = await json<any>(`/api/knowledge/${recordId}`, {
      method: "PATCH",
      body: { pinned: true },
      ...H,
    });
    expect(pinned.status).toBe(200);
    expect(pinned.body.record.pinned).toBe(true);

    const del = await json<any>(`/api/knowledge/${recordId}`, {
      method: "DELETE",
      ...H,
    });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });

    // Gone from the list.
    const after = await json<any>("/api/knowledge", H);
    expect(after.body.records.some((r: any) => r.id === recordId)).toBe(false);
  });

  test("search requires a query", async () => {
    const { status } = await json("/api/knowledge/search", {
      method: "POST",
      body: {},
      ...H,
    });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Distillation grounding + salience, exercised with a MOCKED LLM tool call.
// The suite-wide preload strips OPENROUTER_API_KEY (→ keyless stub), so here we
// set a dummy key and stub global.fetch to return a crafted emit_knowledge_record
// call. This is the only deterministic way to drive the live distill path.
// ---------------------------------------------------------------------------
describe("distill grounding + salience (mocked LLM)", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key-mocked";
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = realFetch;
  });

  function mockLLM(record: Record<string, unknown>): void {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "emit_knowledge_record",
                      arguments: JSON.stringify(record),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
  }

  test("invented refs/signals are dropped; only grounded ones stored", async () => {
    const org = `test-ground-${uid()}`;
    mockLLM({
      kind: "reference",
      status: "current",
      title: "Deploy runbook",
      question: "How do we deploy the service?",
      summary: "The deploy runbook and its migration steps.",
      body: "See PR #482 for the migration steps.",
      entities: ["platform team"],
      refs: ["PR #482", "PR #999"], // PR #999 is NOT in the source → dropped
      verbatim_signals: ["migration steps", "ghost-signal"], // ghost not in source → dropped
      confidence: 0.9,
      worth_saving: true,
    });

    const res = await ingestOne({
      org_id: org,
      meta: {
        source_type: "conversation",
        external_id: "g-1",
        connector_instance_id: "test:ground",
      },
      text: "Deploy runbook: see PR #482 for the migration steps. Owner: platform team.",
    });

    expect(res.status).toBe("stored");
    expect(res.stub).toBe(false);
    expect(res.grounding).toEqual({ refsDropped: 1, signalsDropped: 1 });

    const rows = await listRecords({ orgId: org });
    const row = rows.find((r) => r.external_id === "g-1");
    expect(row).toBeDefined();
    expect(row!.refs).toEqual(["PR #482"]); // invented PR #999 never persisted
  });

  test("worth_saving=false is dropped and never stored (salience gate)", async () => {
    const org = `test-salience-${uid()}`;
    mockLLM({
      kind: "reference",
      status: "current",
      title: "Idle chatter",
      question: "n/a",
      summary: "Ephemeral, low-value content.",
      body: "nothing durable or reusable here",
      entities: [],
      refs: [],
      verbatim_signals: [],
      confidence: 0.1,
      worth_saving: false, // model judged it not worth keeping
    });

    const res = await ingestOne({
      org_id: org,
      meta: {
        source_type: "conversation",
        external_id: "s-1",
        connector_instance_id: "test:salience",
      },
      text: "just some ephemeral chit-chat that is not worth saving at all",
    });

    expect(res.status).toBe("dropped");
    expect(res.id).toBeNull();
    expect(res.worthSaving).toBe(false);

    // Fail-closed: the low-value record must not exist in the store.
    const existing = await findExisting(org, "test:salience", "s-1");
    expect(existing).toBeNull();
  });
});
