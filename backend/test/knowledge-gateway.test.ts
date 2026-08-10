import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { uid, waitFor } from "./helpers";
import { db } from "../src/db/client";
import { providerEvents, runs } from "../src/db/schema";
import { ingestOne } from "../src/knowledge/ingest";
import { mintToolToken, verifyToolToken } from "../src/knowledge/gateway/token";
import { KNOWLEDGE_RETRIEVED } from "../src/knowledge/gateway/tools";
import { createGatewayApp } from "../src/gateway-app";

// ---------------------------------------------------------------------------
// Slice A (mem_op.md 0.2) — the trusted agent-callable knowledge gateway. These
// are the SECURITY tests for the trust boundary: identity comes ONLY from the
// signed token, a bad/expired token fails closed, a tool argument can NEVER
// switch orgs, and cross-org reads are refused. Runs in-process against the Hono
// app (no sandbox, no network) so the boundary is proven deterministically.
// ---------------------------------------------------------------------------

const MCP = "/api/mcp/knowledge";
const gateway = createGatewayApp();

/** POST one JSON-RPC message with a bearer token; return {status, body}. */
async function rpc(token: string | null, msg: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await gateway.request(MCP, {
    method: "POST",
    headers,
    body: JSON.stringify(msg),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function call(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

// ---------------------------------------------------------------------------
// Token module — the cryptographic boundary. Pure, no DB.
// ---------------------------------------------------------------------------
describe("tool token: mint / verify / fail-closed", () => {
  const claims = { orgId: "org-A", userId: "user-1", threadId: "thread-1", runId: "run-1" };

  test("round-trips valid claims", () => {
    const t = mintToolToken(claims, 60_000);
    const v = verifyToolToken(t);
    expect(v).not.toBeNull();
    expect(v!.orgId).toBe("org-A");
    expect(v!.userId).toBe("user-1");
    expect(v!.threadId).toBe("thread-1");
    expect(v!.runId).toBe("run-1");
  });

  test("rejects an expired token (fail closed)", () => {
    const t = mintToolToken(claims, 60_000);
    // 61s in the future → past the 60s TTL.
    expect(verifyToolToken(t, Date.now() + 61_000)).toBeNull();
  });

  test("rejects a tampered payload", () => {
    const t = mintToolToken(claims, 60_000);
    const [v, payload, sig] = t.split(".");
    // Flip a byte in the payload — the recomputed HMAC no longer matches.
    const bad = Buffer.from(payload!, "base64url");
    bad[0] = bad[0]! ^ 0xff;
    const forged = `${v}.${bad.toString("base64url")}.${sig}`;
    expect(verifyToolToken(forged)).toBeNull();
  });

  test("rejects a tampered signature and garbage", () => {
    const t = mintToolToken(claims, 60_000);
    const parts = t.split(".");
    expect(verifyToolToken(`${parts[0]}.${parts[1]}.AAAA`)).toBeNull();
    expect(verifyToolToken("not-a-token")).toBeNull();
    expect(verifyToolToken("")).toBeNull();
    expect(verifyToolToken(null)).toBeNull();
  });

  test("rejects a token minted under a different secret", () => {
    // Simulate a foreign signer by tampering the version prefix (breaks the HMAC
    // signing input) — a stand-in for any key mismatch.
    const t = mintToolToken(claims, 60_000);
    const parts = t.split(".");
    expect(verifyToolToken(`v2.${parts[1]}.${parts[2]}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MCP endpoint — protocol + scoping + ledger. Two orgs, seeded with distinct
// canaries; the gateway must only ever surface the token org's data.
// ---------------------------------------------------------------------------
describe("knowledge MCP gateway", () => {
  const orgA = `gwA-${uid()}`;
  const orgB = `gwB-${uid()}`;
  const canaryA = `alpha${uid().replace(/-/g, "")}`;
  const canaryB = `bravo${uid().replace(/-/g, "")}`;
  let recA = "";
  let recB = "";
  let runId = "";
  let threadId = "";
  let tokenA = "";

  beforeAll(async () => {
    // Seed one distinct, unique fact into each org (keyless stub distillation).
    const a = await ingestOne({
      org_id: orgA,
      user_id: "user-A",
      meta: { source_type: "document", external_id: "kb-a", connector_instance_id: "gw:test", source_url: "https://ex/a" },
      text: `Runbook ${canaryA}: to roll back the payments service run 'skynet rollback payments'. Unique fact ${canaryA}.`,
    });
    recA = a.id!;
    const b = await ingestOne({
      org_id: orgB,
      user_id: "user-B",
      meta: { source_type: "document", external_id: "kb-b", connector_instance_id: "gw:test", source_url: "https://ex/b" },
      text: `Runbook ${canaryB}: the billing owner is Dana. Unique fact ${canaryB}.`,
    });
    recB = b.id!;

    // A real (running) run in org A so the retrieval ledger has an FK target and
    // the active-run resolver attributes frames to it.
    runId = uid("run");
    threadId = runId;
    await db.insert(runs).values({
      id: runId,
      orgId: orgA,
      userId: "user-A",
      prompt: "ask",
      model: "claude-haiku-4-5",
      engine: "opencode",
      status: "running",
      threadId,
    });

    tokenA = mintToolToken({ orgId: orgA, userId: "user-A", threadId, runId }, 60_000);
  });

  test("no / bad token → 401 (fail closed)", async () => {
    const noTok = await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(noTok.status).toBe(401);
    const expired = mintToolToken({ orgId: orgA, userId: "", threadId, runId }, -1_000);
    const badTok = await rpc(expired, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(badTok.status).toBe(401);
  });

  test("a valid capability is inert when its matching turn is not running", async () => {
    const inactiveRunId = uid("run");
    await db.insert(runs).values({
      id: inactiveRunId,
      orgId: orgA,
      userId: "user-A",
      prompt: "done",
      model: "claude-haiku-4-5",
      engine: "opencode",
      status: "completed",
      threadId: inactiveRunId,
    });
    const inactiveToken = mintToolToken(
      {
        orgId: orgA,
        userId: "user-A",
        threadId: inactiveRunId,
        runId: inactiveRunId,
      },
      60_000,
    );
    const response = await rpc(inactiveToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "inactive_capability" });
  });

  test("a stale token stays inert when a newer run in the same thread is running", async () => {
    const staleRunId = uid("run");
    const sharedThreadId = uid("thread");
    await db.insert(runs).values([
      {
        id: staleRunId,
        orgId: orgA,
        userId: "user-A",
        prompt: "old",
        model: "claude-haiku-4-5",
        engine: "opencode",
        status: "completed",
        threadId: sharedThreadId,
      },
      {
        id: uid("run"),
        orgId: orgA,
        userId: "user-A",
        prompt: "new",
        model: "claude-haiku-4-5",
        engine: "opencode",
        status: "running",
        threadId: sharedThreadId,
      },
    ]);
    const staleToken = mintToolToken(
      { orgId: orgA, userId: "user-A", threadId: sharedThreadId, runId: staleRunId },
      60_000,
    );
    const response = await rpc(staleToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "inactive_capability" });
  });

  test("rejects an oversized JSON-RPC batch", async () => {
    const response = await rpc(
      tokenA,
      Array.from({ length: 17 }, (_, index) => ({
        jsonrpc: "2.0",
        id: index,
        method: "tools/list",
      })),
    );
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "batch_too_large" });
  });

  test("rejects an oversized MCP request before parsing it", async () => {
    const response = await rpc(tokenA, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "knowledge_search", arguments: { query: "x".repeat(1024 * 1024) } },
    });
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "request_too_large" });
  });

  test("initialize negotiates + advertises tools capability", async () => {
    const r = await rpc(tokenA, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(r.status).toBe(200);
    expect(r.body.result.protocolVersion).toBe("2025-06-18");
    expect(r.body.result.capabilities.tools).toBeDefined();
    expect(r.body.result.serverInfo.name).toBe("skynet-knowledge");
  });

  test("tools/list exposes knowledge, memory, artifact, and web tools", async () => {
    const r = await rpc(tokenA, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(r.status).toBe(200);
    const names = (r.body.result.tools as { name: string }[]).map((t) => t.name).sort();
    // Knowledge (read-only) + Tencent-backed memory + Anthropic-native web_search
    // all ride the same gateway.
    expect(names).toEqual([
      "artifact_publish",
      "knowledge_read",
      "knowledge_search",
      "memory_correct",
      "memory_forget",
      "memory_read",
      "memory_remember",
      "memory_search",
      "web_search",
    ]);
    // No tool declares a tenant/org input — identity is token-only.
    for (const t of r.body.result.tools as { inputSchema: any }[]) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      expect(props).not.toContain("org_id");
      expect(props).not.toContain("orgId");
    }
  });

  test("knowledge_search returns ONLY the token org's data, with citation", async () => {
    const r = await rpc(tokenA, call(3, "knowledge_search", { query: `${canaryA} rollback` }));
    expect(r.status).toBe(200);
    const result = r.body.result;
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toContain(canaryA); // org A's fact is present
    expect(text).not.toContain(canaryB); // org B's fact is NEVER present
    const ids = (result.structuredContent.results as { id: string; citation: string }[]).map((x) => x.id);
    expect(ids).toContain(recA);
    expect(ids).not.toContain(recB);
    // Citations are present + stable (the seeded source_url).
    const hit = result.structuredContent.results.find((x: any) => x.id === recA);
    expect(hit.citation).toBe("https://ex/a");
  });

  test("a tool arg can NOT widen scope to another org", async () => {
    // Smuggle org-switching args every which way — the schema ignores them and
    // execution reads org solely from the token, so org B stays invisible.
    const r = await rpc(
      tokenA,
      call(4, "knowledge_search", { query: canaryB, org_id: orgB, orgId: orgB, scope: orgB, team_id: orgB }),
    );
    expect(r.status).toBe(200);
    // Assert on the DATA returned (not the query echo): org B's record must never
    // appear in results under org A's token, no matter what the args claim.
    const results = r.body.result.structuredContent.results as { id: string }[];
    expect(results.some((x) => x.id === recB)).toBe(false);
  });

  test("knowledge_read refuses another org's document id (fail closed, no oracle)", async () => {
    const r = await rpc(tokenA, call(5, "knowledge_read", { documentId: recB }));
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toContain("your organization");
  });

  test("knowledge_read returns the token org's own document", async () => {
    const r = await rpc(tokenA, call(6, "knowledge_read", { documentId: recA }));
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBeFalsy();
    expect(r.body.result.structuredContent.id).toBe(recA);
    expect(r.body.result.content[0].text).toContain(canaryA);
  });

  test("every retrieval is logged to the ledger (knowledge.retrieved frame)", async () => {
    // The searches above fire-and-forget ledger frames; poll for at least one.
    const frame = await waitFor(async () => {
      const rows = await db
        .select()
        .from(providerEvents)
        .where(and(eq(providerEvents.runId, runId), eq(providerEvents.eventType, KNOWLEDGE_RETRIEVED)));
      return rows.length > 0 ? rows : null;
    });
    expect(frame.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(frame[0]!.payload as string);
    expect(payload.source).toBe("knowledge");
    expect(payload.scope.orgId).toBe(orgA);
    expect(payload.scope.actorUserId).toBe("user-A");
    expect(payload.itemCount).toBeGreaterThanOrEqual(1);
    expect(payload.items[0].citation).toBeTruthy();
    expect(frame[0]!.provider).toBe("skynet-knowledge");
  });

  test("unknown tool → JSON-RPC method error", async () => {
    const r = await rpc(tokenA, call(7, "knowledge_delete", { id: recA }));
    expect(r.status).toBe(200);
    expect(r.body.error.code).toBe(-32602);
  });
});
