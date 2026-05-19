import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { providerEvents, runs, schedules } from "../src/db/schema";
import { createGatewayApp } from "../src/gateway-app";
import { mintToolToken, verifyToolToken } from "../src/knowledge/gateway/token";
import { KNOWLEDGE_RETRIEVED } from "../src/knowledge/gateway/tools";
import { ingestOne } from "../src/knowledge/ingest";
import { createSkillWithRevision } from "../src/skills/repo";
import { uid, waitFor } from "./helpers";

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
    expect(v!.scope).toBe("run");
  });

  test("round-trips thread scope for resident ACP sessions", () => {
    const t = mintToolToken({ ...claims, scope: "thread" }, 60_000);
    const v = verifyToolToken(t);
    expect(v).not.toBeNull();
    expect(v!.orgId).toBe("org-A");
    expect(v!.userId).toBe("user-1");
    expect(v!.threadId).toBe("thread-1");
    expect(v!.runId).toBe("run-1");
    expect(v!.scope).toBe("thread");
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
  let tokenB = "";

  beforeAll(async () => {
    // Seed one distinct, unique fact into each org (keyless stub distillation).
    const a = await ingestOne({
      org_id: orgA,
      user_id: "user-A",
      meta: {
        source_type: "document",
        external_id: "kb-a",
        connector_instance_id: "gw:test",
        source_url: "https://ex/a",
      },
      text: `Runbook ${canaryA}: to roll back the payments service run 'skynet rollback payments'. Unique fact ${canaryA}.`,
    });
    recA = a.id!;
    const b = await ingestOne({
      org_id: orgB,
      user_id: "user-B",
      meta: {
        source_type: "document",
        external_id: "kb-b",
        connector_instance_id: "gw:test",
        source_url: "https://ex/b",
      },
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

    const runIdB = uid("run");
    await db.insert(runs).values({
      id: runIdB,
      orgId: orgB,
      userId: "user-B",
      prompt: "ask",
      model: "claude-haiku-4-5",
      engine: "opencode",
      status: "running",
      threadId: runIdB,
    });
    tokenB = mintToolToken(
      { orgId: orgB, userId: "user-B", threadId: runIdB, runId: runIdB },
      60_000,
    );
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

  test("a thread-scoped capability retained by a resident ACP session resolves the same user's current run", async () => {
    const staleRunId = uid("run");
    const currentRunId = uid("run");
    const sharedThreadId = uid("thread");
    await db.insert(runs).values([
      {
        id: staleRunId,
        orgId: orgA,
        userId: "user-old",
        prompt: "old ACP turn",
        model: "claude-haiku-4-5",
        engine: "codex",
        status: "completed",
        threadId: sharedThreadId,
      },
      {
        id: currentRunId,
        orgId: orgA,
        userId: "user-old",
        prompt: "current ACP turn",
        model: "claude-haiku-4-5",
        engine: "codex",
        status: "running",
        threadId: sharedThreadId,
      },
    ]);
    const retainedToken = mintToolToken(
      {
        orgId: orgA,
        userId: "user-old",
        threadId: sharedThreadId,
        runId: staleRunId,
        scope: "thread",
      },
      60_000,
    );
    const response = await rpc(
      retainedToken,
      call(21, "knowledge_search", { query: `${canaryA} rollback` }),
    );
    expect(response.status).toBe(200);
    expect(response.body.result.isError).toBeFalsy();

    const frame = await waitFor(async () => {
      const rows = await db
        .select()
        .from(providerEvents)
        .where(
          and(
            eq(providerEvents.runId, currentRunId),
            eq(providerEvents.eventType, KNOWLEDGE_RETRIEVED),
          ),
        );
      return rows.length > 0 ? rows : null;
    });
    const payload = JSON.parse(frame[0]!.payload as string);
    expect(payload.scope.actorUserId).toBe("user-old");

    const staleFrames = await db
      .select()
      .from(providerEvents)
      .where(
        and(
          eq(providerEvents.runId, staleRunId),
          eq(providerEvents.eventType, KNOWLEDGE_RETRIEVED),
        ),
      );
    expect(staleFrames).toEqual([]);
  });

  test("a retained thread capability fails closed when another user owns the current turn", async () => {
    const staleRunId = uid("run");
    const currentRunId = uid("run");
    const sharedThreadId = uid("thread");
    await db.insert(runs).values([
      {
        id: staleRunId,
        orgId: orgA,
        userId: "user-old",
        prompt: "old ACP turn",
        model: "claude-haiku-4-5",
        engine: "codex",
        status: "completed",
        threadId: sharedThreadId,
      },
      {
        id: currentRunId,
        orgId: orgA,
        userId: "user-current",
        prompt: "current ACP turn",
        model: "claude-haiku-4-5",
        engine: "codex",
        status: "running",
        threadId: sharedThreadId,
      },
    ]);
    const retainedToken = mintToolToken(
      {
        orgId: orgA,
        userId: "user-old",
        threadId: sharedThreadId,
        runId: staleRunId,
        scope: "thread",
      },
      60_000,
    );
    const response = await rpc(retainedToken, { jsonrpc: "2.0", id: 22, method: "tools/list" });
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
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.result.protocolVersion).toBe("2025-06-18");
    expect(r.body.result.capabilities.tools).toBeDefined();
    expect(r.body.result.serverInfo.name).toBe("skynet-knowledge");
    expect(r.body.result.instructions).toContain("Call tools/list before use");
    expect(new TextEncoder().encode(r.body.result.instructions as string).byteLength).toBeLessThan(
      600,
    );
  });

  test("tools/list exposes the composed provider-neutral gateway catalog", async () => {
    const r = await rpc(tokenA, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(r.status).toBe(200);
    const names = (r.body.result.tools as { name: string }[]).map((t) => t.name).sort();
    // Read, management, and execution capabilities share one identity-bound
    // catalog instead of provider-specific prompt injection. The test preload
    // explicitly marks synthetic provider lanes ready, so this live run also
    // advertises child-session orchestration. Focused child-session tests cover
    // the fail-closed catalog states.
    expect(names).toEqual([
      "artifact_publish",
      "automation_create",
      "automation_delete",
      "automation_get",
      "automation_history",
      "automation_list",
      "automation_run_now",
      "automation_schema",
      "automation_update",
      "blueprint_apply_plan",
      "blueprint_get",
      "blueprint_list",
      "blueprint_validate",
      "child_session_create",
      "child_session_events",
      "child_session_gather",
      "child_session_list",
      "computer_screenshot",
      "computer_sequence",
      "desktop_recording_start",
      "desktop_recording_stop",
      "gcs_list_buckets",
      "github_clone_repository",
      "github_repositories",
      "knowledge_draft_archive",
      "knowledge_draft_create",
      "knowledge_draft_get",
      "knowledge_draft_list",
      "knowledge_draft_publish",
      "knowledge_draft_update",
      "knowledge_read",
      "knowledge_search",
      "memory_correct",
      "memory_forget",
      "memory_read",
      "memory_remember",
      "memory_search",
      "skill_activate",
      "skills_list",
      "web_search",
    ]);
    // No tool declares a tenant/org input — identity is token-only.
    for (const t of r.body.result.tools as { inputSchema: any }[]) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      expect(props).not.toContain("org_id");
      expect(props).not.toContain("orgId");
    }
  });

  test("compact tools/list exposes searchable meta tools without losing schemas", async () => {
    const previous = process.env.GATEWAY_COMPACT_TOOLS;
    process.env.GATEWAY_COMPACT_TOOLS = "1";
    try {
      const listed = await rpc(tokenA, { jsonrpc: "2.0", id: 70, method: "tools/list" });
      expect(listed.status).toBe(200);
      expect(
        (listed.body.result.tools as { name: string }[]).map((tool) => tool.name).sort(),
      ).toEqual(["gateway_tool_describe", "gateway_tools_search"]);

      const search = await rpc(
        tokenA,
        call(71, "gateway_tools_search", { query: "automation create" }),
      );
      expect(search.status).toBe(200);
      expect(search.body.result.structuredContent.tools).toContainEqual(
        expect.objectContaining({ name: "automation_create" }),
      );

      const describe = await rpc(
        tokenA,
        call(72, "gateway_tool_describe", { name: "automation_create" }),
      );
      expect(describe.status).toBe(200);
      expect(describe.body.result.structuredContent.tool).toMatchObject({
        name: "automation_create",
        inputSchema: expect.objectContaining({
          required: expect.arrayContaining(["name", "prompt", "cron"]),
        }),
      });
    } finally {
      if (previous === undefined) {
        delete process.env.GATEWAY_COMPACT_TOOLS;
      } else {
        process.env.GATEWAY_COMPACT_TOOLS = previous;
      }
    }
  });

  test("knowledge management drafts are token-scoped, draft-first, bounded, confirmed before publish, and archived", async () => {
    const draftCanary = `draft${uid().replace(/-/g, "")}`;
    const updatedCanary = `updated${uid().replace(/-/g, "")}`;
    const created = await rpc(
      tokenA,
      call(38, "knowledge_draft_create", {
        title: "Gateway draft lifecycle",
        content: `Initial draft fact ${draftCanary}`,
        orgId: orgB,
        userId: "user-B",
      }),
    );
    expect(created.status).toBe(200);
    expect(created.body.result.isError).toBe(true);
    expect(created.body.result.content[0].text).toContain("do not accept identity arguments");

    const cleanCreate = await rpc(
      tokenA,
      call(39, "knowledge_draft_create", {
        title: "Gateway draft lifecycle",
        content: `Initial draft fact ${draftCanary}`,
      }),
    );
    expect(cleanCreate.status).toBe(200);
    expect(cleanCreate.body.result.isError).toBeFalsy();
    const document = cleanCreate.body.result.structuredContent.document;
    const documentId = document.id as string;
    const baseRevisionId = document.revisionId as string;
    expect(document.status).toBe("draft");
    expect(document.content).toContain(draftCanary);

    const notSearchable = await rpc(tokenA, call(40, "knowledge_search", { query: draftCanary }));
    expect(notSearchable.body.result.structuredContent.results).toEqual([]);

    const otherOrgGet = await rpc(tokenB, call(41, "knowledge_draft_get", { documentId }));
    expect(otherOrgGet.status).toBe(200);
    expect(otherOrgGet.body.result.isError).toBe(true);
    expect(otherOrgGet.body.result.structuredContent.status).toBe(404);

    const staleUpdate = await rpc(
      tokenA,
      call(42, "knowledge_draft_update", {
        documentId,
        content: `Stale write ${updatedCanary}`,
        baseRevisionId: "00000000-0000-0000-0000-000000000000",
      }),
    );
    expect(staleUpdate.body.result.isError).toBe(true);
    expect(staleUpdate.body.result.structuredContent.status).toBe(409);

    const updated = await rpc(
      tokenA,
      call(43, "knowledge_draft_update", {
        documentId,
        content: `Updated draft fact ${updatedCanary}`,
        baseRevisionId,
      }),
    );
    expect(updated.body.result.isError).toBeFalsy();
    const currentRevisionId = updated.body.result.structuredContent.document.revisionId as string;
    expect(currentRevisionId).not.toBe(baseRevisionId);

    const titleUpdate = await rpc(
      tokenA,
      call(44, "knowledge_draft_update", {
        documentId,
        content: `Another ${updatedCanary}`,
        title: "Unsupported title change",
      }),
    );
    expect(titleUpdate.body.result.isError).toBe(true);
    expect(titleUpdate.body.result.structuredContent.unsupported).toBe("title_update");

    for (let i = 0; i < 11; i += 1) {
      const extra = await rpc(
        tokenA,
        call(45 + i, "knowledge_draft_create", {
          title: `Bounded draft ${i}`,
          content: `Bounded content ${draftCanary} ${i}`,
        }),
      );
      expect(extra.body.result.isError).toBeFalsy();
    }
    const listed = await rpc(
      tokenA,
      call(57, "knowledge_draft_list", { status: "draft", limit: 50 }),
    );
    expect(listed.body.result.isError).toBeFalsy();
    expect(listed.body.result.structuredContent.documents.length).toBeLessThanOrEqual(10);
    expect(listed.body.result.structuredContent.truncated).toBe(true);

    const refusedPublish = await rpc(tokenA, call(58, "knowledge_draft_publish", { documentId }));
    expect(refusedPublish.body.result.isError).toBe(true);
    expect(refusedPublish.body.result.structuredContent.requiredConfirmationToken).toBe(
      `publish:${documentId}`,
    );

    const published = await rpc(
      tokenA,
      call(59, "knowledge_draft_publish", {
        documentId,
        baseRevisionId: currentRevisionId,
        confirmPublish: true,
      }),
    );
    expect(published.body.result.isError).toBeFalsy();
    expect(published.body.result.structuredContent.document.status).toBe("published");

    const searchable = await rpc(tokenA, call(60, "knowledge_search", { query: updatedCanary }));
    expect(
      (searchable.body.result.structuredContent.results as { title: string }[]).some(
        (result) => result.title === "Gateway draft lifecycle",
      ),
    ).toBe(true);

    const archived = await rpc(tokenA, call(61, "knowledge_draft_archive", { documentId }));
    expect(archived.body.result.isError).toBeFalsy();
    expect(archived.body.result.structuredContent.document.status).toBe("archived");

    const afterArchive = await rpc(tokenA, call(62, "knowledge_search", { query: updatedCanary }));
    expect(
      (afterArchive.body.result.structuredContent.results as { title: string }[]).some(
        (result) => result.title === "Gateway draft lifecycle",
      ),
    ).toBe(false);
  });

  test("automation tools create disabled, require explicit enable, run, history, and delete", async () => {
    const schema = await rpc(tokenA, call(28, "automation_schema", {}));
    expect(schema.body.result.isError).toBeFalsy();
    expect(schema.body.result.structuredContent.schema.fields.optional).toContain("skill");
    expect(schema.body.result.structuredContent.schema.fields.serverDerived).toContain(
      "run_actor_id",
    );

    const skill = await createSkillWithRevision({
      orgId: orgA,
      name: `Gateway Playbook ${uid()}`,
      kind: "playbook",
      description: "Pinned automation playbook",
      tags: ["automation"],
      sections: {
        overview: ["Use for lifecycle tests."],
        procedure: ["Say ok."],
        verify: ["Run completes."],
      },
    });
    expect(skill).not.toBeNull();

    const inherited = await rpc(
      tokenA,
      call(29, "automation_create", {
        name: "Inherited engine draft",
        cron: "15 5 * * *",
        prompt: `say inherited ok ${"x".repeat(200)}`,
        skill: { id: skill!.id },
        tags: ["daily", "ops"],
        concurrency: { maxInFlight: 1 },
        queue: { mode: "drop" },
        costLimits: { maxUsdPerRun: 1 },
        frequencyLimits: { maxRunsPerDay: 2 },
        approvalPolicy: { mode: "manual" },
        enablementPolicy: { requiredConfirmation: true },
      }),
    );
    expect(inherited.body.result.isError).toBeFalsy();
    expect(inherited.body.result.structuredContent.automation).toMatchObject({
      engine: "opencode",
      model: "claude-haiku-4-5",
      skill_id: skill!.id,
      skill_version: 1,
      tags: ["daily", "ops"],
      run_actor_id: "user-A",
      enabled: false,
    });
    expect(inherited.body.result.structuredContent.automation.prompt).toBeUndefined();
    expect(inherited.body.result.structuredContent.automation.prompt_preview).toContain("...");
    const inheritedId = inherited.body.result.structuredContent.automation.id;
    const got = await rpc(tokenA, call(292, "automation_get", { id: inheritedId }));
    expect(got.body.result.structuredContent.automation.skill_id).toBe(skill!.id);
    const removedInherited = await rpc(
      tokenA,
      call(291, "automation_delete", {
        id: inheritedId,
      }),
    );
    expect(removedInherited.body.result.structuredContent.deleted).toBe(true);

    const created = await rpc(
      tokenA,
      call(30, "automation_create", {
        name: "Gateway automation lifecycle",
        cron: "0 6 * * *",
        timezone: "Asia/Kolkata",
        prompt: "say lifecycle ok",
        engine: "mock",
      }),
    );
    expect(created.status).toBe(200);
    expect(created.body.result.isError).toBeFalsy();
    const automation = created.body.result.structuredContent.automation;
    expect(automation.org_id).toBe(orgA);
    expect(automation.user_id).toBe("user-A");
    expect(automation.enabled).toBe(false);

    const rejectedCreate = await rpc(
      tokenA,
      call(31, "automation_create", {
        name: "Unsafe enabled create",
        cron: "0 7 * * *",
        prompt: "should not create enabled",
        engine: "mock",
        enabled: true,
      }),
    );
    expect(rejectedCreate.body.result.isError).toBe(true);
    expect(rejectedCreate.body.result.content[0].text).toContain("always creates disabled");

    const refusedEnable = await rpc(
      tokenA,
      call(32, "automation_update", {
        id: automation.id,
        enabled: true,
      }),
    );
    expect(refusedEnable.body.result.isError).toBe(true);
    expect(refusedEnable.body.result.content[0].text).toContain("confirmEnable=true");

    const deliveryDraft = await rpc(
      tokenA,
      call(321, "automation_update", {
        id: automation.id,
        delivery: { mode: "summary" },
        notifications: { channels: ["slack"] },
      }),
    );
    expect(deliveryDraft.body.result.isError).toBeFalsy();
    const refusedDeliveryEnable = await rpc(
      tokenA,
      call(322, "automation_update", {
        id: automation.id,
        enabled: true,
        confirmEnable: true,
      }),
    );
    expect(refusedDeliveryEnable.body.result.isError).toBe(true);
    expect(refusedDeliveryEnable.body.result.structuredContent.error.error).toBe(
      "automation_delivery_not_ready",
    );
    const clearedDelivery = await rpc(
      tokenA,
      call(323, "automation_update", {
        id: automation.id,
        delivery: null,
        notifications: null,
      }),
    );
    expect(clearedDelivery.body.result.isError).toBeFalsy();

    const enabled = await rpc(
      tokenA,
      call(33, "automation_update", {
        id: automation.id,
        skill: { id: skill!.id },
        enabled: true,
        confirmEnable: true,
      }),
    );
    expect(enabled.body.result.isError).toBeFalsy();
    expect(enabled.body.result.structuredContent.automation.enabled).toBe(true);
    expect(enabled.body.result.structuredContent.automation.skill_id).toBe(skill!.id);

    const runNow = await rpc(tokenA, call(34, "automation_run_now", { id: automation.id }));
    expect(runNow.body.result.isError).toBeFalsy();
    const runId = runNow.body.result.structuredContent.run_id as string;
    expect(runId).toMatch(/[0-9a-f-]{36}/);
    const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(run).toMatchObject({
      skillId: skill!.id,
      skillVersion: 1,
      skillContentHash: enabled.body.result.structuredContent.automation.skill_content_hash,
      userId: "user-A",
    });

    const history = await waitFor(async () => {
      const response = await rpc(tokenA, call(35, "automation_history", { id: automation.id }));
      const firings = response.body.result.structuredContent.firings as {
        run_id: string;
        trigger: string;
      }[];
      return firings.some((f) => f.run_id === runId && f.trigger === "manual") ? firings : null;
    });
    expect(history.some((f) => f.run_id === runId)).toBe(true);

    const deleted = await rpc(tokenA, call(36, "automation_delete", { id: automation.id }));
    expect(deleted.body.result.isError).toBeFalsy();
    expect(deleted.body.result.structuredContent.deleted).toBe(true);

    const rows = await db
      .select()
      .from(schedules)
      .where(and(eq(schedules.id, automation.id), eq(schedules.orgId, orgA)));
    expect(rows).toEqual([]);

    const missing = await rpc(tokenA, call(37, "automation_history", { id: automation.id }));
    expect(missing.body.result.isError).toBe(true);
    expect(missing.body.result.structuredContent.status).toBe(404);
  });

  test("knowledge_search returns ONLY the token org's data, with citation", async () => {
    const r = await rpc(tokenA, call(3, "knowledge_search", { query: `${canaryA} rollback` }));
    expect(r.status).toBe(200);
    const result = r.body.result;
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toContain(canaryA); // org A's fact is present
    expect(text).not.toContain(canaryB); // org B's fact is NEVER present
    const ids = (result.structuredContent.results as { id: string; citation: string }[]).map(
      (x) => x.id,
    );
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
      call(4, "knowledge_search", {
        query: canaryB,
        org_id: orgB,
        orgId: orgB,
        scope: orgB,
        team_id: orgB,
      }),
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
        .where(
          and(eq(providerEvents.runId, runId), eq(providerEvents.eventType, KNOWLEDGE_RETRIEVED)),
        );
      return rows.some((row) => JSON.parse(row.payload as string).itemCount > 0) ? rows : null;
    });
    expect(frame.length).toBeGreaterThanOrEqual(1);
    const nonEmptyFrame = frame.find((row) => JSON.parse(row.payload as string).itemCount > 0);
    expect(nonEmptyFrame).toBeDefined();
    const payload = JSON.parse(nonEmptyFrame!.payload as string);
    expect(payload.source).toBe("knowledge");
    expect(payload.scope.orgId).toBe(orgA);
    expect(payload.scope.actorUserId).toBe("user-A");
    expect(payload.itemCount).toBeGreaterThanOrEqual(1);
    expect(payload.items[0].citation).toBeTruthy();
    expect(nonEmptyFrame!.provider).toBe("skynet-knowledge");
  });

  test("unknown tool → JSON-RPC method error", async () => {
    const r = await rpc(tokenA, call(7, "knowledge_delete", { id: recA }));
    expect(r.status).toBe(200);
    expect(r.body.error.code).toBe(-32602);
  });
});
