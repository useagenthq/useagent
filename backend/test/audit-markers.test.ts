import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { uid } from "./helpers";
import { db } from "../src/db/client";
import { providerEvents, runs } from "../src/db/schema";
import { ingestOne } from "../src/knowledge/ingest";
import { mintToolToken } from "../src/knowledge/gateway/token";
import { KNOWLEDGE_RETRIEVED } from "../src/knowledge/gateway/tools";
import { createGatewayApp } from "../src/gateway-app";

// Fix 6 — audit markers are AWAITED, so a crash can't lose evidence of an action
// that succeeded. The strongest deterministic proof is the knowledge retrieval
// ledger: it used to be fire-and-forget (the existing gateway test has to POLL
// for it). Because the write is now awaited INSIDE the tool handler, the frame
// MUST exist the instant the tool call returns — with NO polling — and while the
// run is still running (i.e. before it can settle).
//
// The sibling markers are covered by existing suites, now deterministic:
//   - skill.loaded → test/skills-versioning.test.ts (awaited before the engine runs);
//   - context.retrieved → the worker awaits it before the engine turn.

const MCP = "/api/mcp/knowledge";
const gateway = createGatewayApp();

async function rpc(token: string, msg: unknown): Promise<{ status: number; body: any }> {
  const res = await gateway.request(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(msg),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const call = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("audit markers are durable before the run settles", () => {
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  test("knowledge.retrieved ledger frame exists the instant the tool returns (no polling), run still running", async () => {
    const org = `am-${uid()}`;
    const canary = `deploys${uid().replace(/-/g, "")}`;
    await ingestOne({
      org_id: org,
      user_id: "user-1",
      meta: { source_type: "document", external_id: "am-1", connector_instance_id: "am:test", source_url: "https://ex/am" },
      text: `Runbook ${canary}: to deploy, run 'skynet deploy'. Unique fact ${canary}.`,
    });

    // A real running run so the ledger has an FK target and the active-run
    // resolver attributes the frame to it.
    const runId = uid("run");
    const threadId = runId;
    await db.insert(runs).values({
      id: runId,
      orgId: org,
      userId: "user-1",
      prompt: "ask",
      model: "claude-haiku-4-5",
      engine: "opencode",
      status: "running",
      threadId,
    });
    const token = mintToolToken({ orgId: org, userId: "user-1", threadId, runId }, 60_000);

    // The tool call. If the ledger write were still fire-and-forget, the frame
    // could be absent here; because it is AWAITED in the handler it is durable
    // by the time the response returns.
    const r = await rpc(token, call(1, "knowledge_search", { query: canary }));
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBeFalsy();

    // NO waitFor: the frame must already be persisted.
    const frames = await db
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.runId, runId), eq(providerEvents.eventType, KNOWLEDGE_RETRIEVED)));
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(frames[0]!.payload as string);
    expect(payload.source).toBe("knowledge");
    expect(payload.scope.orgId).toBe(org);

    // The marker landed while the run is STILL running — strictly before settle.
    const [runRow] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1);
    expect(runRow!.status).toBe("running");
  });
});
