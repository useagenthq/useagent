import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, isNotNull, isNull, like } from "drizzle-orm";
import "../../index";
import { commands, providerEvents, runs } from "../../db/schema";
import { db } from "../../db/client";
import { createRun, setRunEngineSession, setRunStatus } from "../../runs/repo";
import { recordProviderEvent } from "../../runs/provider-events";
import { createGatewayApp } from "../../gateway-app";
import { executeRegisteredGatewayTool } from "./operation-registry";
import {
  CHILD_SESSION_TOOLS,
  executeChildSessionTool,
} from "./child-session-tools";
import { mintToolToken, type ToolTokenClaims } from "./token";

const touchedOrgs = new Set<string>();

const ENV_KEYS = [
  "SKYNET_DEV_MODE",
  "ENABLED_ENGINES",
  "ENGINE_READINESS_CODEX",
  "ENGINE_READINESS_OPENCODE",
  "PROVIDER_HEALTH_OPENAI",
  "PROVIDER_HEALTH_OPENROUTER",
] as const;

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
  {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SKYNET_DEV_MODE = "true";
  process.env.ENABLED_ENGINES = "opencode,codex";
  process.env.ENGINE_READINESS_CODEX = "ready";
  process.env.ENGINE_READINESS_OPENCODE = "ready";
  process.env.PROVIDER_HEALTH_OPENAI = "ready";
  process.env.PROVIDER_HEALTH_OPENROUTER = "ready";
});

afterEach(async () => {
  for (const orgId of touchedOrgs) {
    const rows = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.orgId, orgId));
    const runIds = rows.map((row) => row.id);
    for (const runId of runIds) {
      await db.delete(providerEvents).where(eq(providerEvents.runId, runId));
    }
    await db.delete(commands).where(eq(commands.orgId, orgId));
    await db
      .delete(runs)
      .where(and(eq(runs.orgId, orgId), isNotNull(runs.parentRunId)));
    await db
      .delete(runs)
      .where(and(eq(runs.orgId, orgId), isNull(runs.parentRunId)));
  }
  touchedOrgs.clear();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function fixture(
  engine: "opencode" | "claude" | "codex" = "opencode",
  options: { readonly t3?: boolean } = {},
): Promise<ToolTokenClaims> {
  const orgId = `org-child-session-${crypto.randomUUID()}`;
  const runId = crypto.randomUUID();
  touchedOrgs.add(orgId);
  await createRun({
    id: runId,
    prompt: "coordinate child work",
    model:
      engine === "opencode"
        ? "openai/gpt-5.6-luna"
        : engine === "codex"
          ? "gpt-5.6-luna"
          : "claude-opus-5",
    engine,
    orgId,
    userId: "user-1",
    parentRunId: null,
    threadId: runId,
    repos: ["acme/new-skynet"],
    memoryScope: "org",
  });
  if (options.t3) await setRunEngineSession(runId, `skynet-thread-${runId}`);
  await setRunStatus(runId, "running");
  return {
    orgId,
    userId: "user-1",
    threadId: runId,
    runId,
    scope: "run",
    exp: Date.now() + 60_000,
  };
}

function childId(
  result: Awaited<ReturnType<typeof executeChildSessionTool>>,
): string {
  const child = result.structuredContent?.child as { id?: string } | undefined;
  if (!child?.id) throw new Error("child id missing from result");
  return child.id;
}

describe("child session gateway tools", () => {
  test("schemas never accept caller-supplied org or user identity", () => {
    const schemas = CHILD_SESSION_TOOLS.map((tool) => tool.inputSchema);
    expect(JSON.stringify(schemas)).not.toContain("orgId");
    expect(JSON.stringify(schemas)).not.toContain("userId");
    expect(JSON.stringify(schemas)).not.toContain("actorId");
  });

  test("advertisement follows live child-session capability and readiness", async () => {
    const app = createGatewayApp();
    const enabledClaims = await fixture();
    const enabledToken = mintToolToken(enabledClaims, 60_000);
    const enabled = await app.request("/api/mcp/knowledge", {
      method: "POST",
      headers: {
        authorization: `Bearer ${enabledToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const enabledBody = (await enabled.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(enabledBody.result.tools.map((tool) => tool.name)).toContain(
      "child_session_create",
    );

    const runtimeCodexClaims = await fixture("codex", { t3: true });
    const runtimeCodexToken = mintToolToken(runtimeCodexClaims, 60_000);
    const runtimeCodex = await app.request("/api/mcp/knowledge", {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtimeCodexToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const runtimeCodexBody = (await runtimeCodex.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(runtimeCodexBody.result.tools.map((tool) => tool.name)).toContain(
      "child_session_create",
    );

    const disabledClaims = await fixture("claude");
    const disabledToken = mintToolToken(disabledClaims, 60_000);
    const disabled = await app.request("/api/mcp/knowledge", {
      method: "POST",
      headers: {
        authorization: `Bearer ${disabledToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const disabledBody = (await disabled.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(disabledBody.result.tools.map((tool) => tool.name)).not.toContain(
      "child_session_create",
    );
  });

  test("create is idempotent and derives child identity from the live run", async () => {
    const claims = await fixture();
    const created = await executeChildSessionTool(
      claims,
      "child_session_create",
      {
        idempotencyKey: "fanout-a",
        prompt: "Inspect the provider-neutral event path.",
        orgId: "evil-org",
        userId: "evil-user",
      },
    );
    const firstId = childId(created);
    expect(created.isError).toBeUndefined();
    expect(created.structuredContent?.status).toBe("created");

    const replayed = await executeChildSessionTool(
      claims,
      "child_session_create",
      {
        idempotencyKey: "fanout-a",
        prompt: "Inspect the provider-neutral event path.",
      },
    );
    expect(replayed.structuredContent?.status).toBe("replayed");
    expect(childId(replayed)).toBe(firstId);

    const [child] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, firstId))
      .limit(1);
    expect(child?.orgId).toBe(claims.orgId);
    expect(child?.userId).toBe(claims.userId);
    expect(child?.threadId).toBe(claims.threadId);
    expect(child?.parentRunId).toBe(claims.runId);
    expect(child?.engine).toBe("opencode");
    expect(child?.model).toBe("openai/gpt-5.6-luna");

    const childCommands = await db
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.orgId, claims.orgId),
          like(commands.idempotencyKey, `child-session:${claims.threadId}:%`),
        ),
      );
    expect(childCommands).toHaveLength(1);
  });

  test("list, events, and gather are bounded durable projections", async () => {
    const claims = await fixture();
    const first = await executeChildSessionTool(
      claims,
      "child_session_create",
      {
        idempotencyKey: "one",
        prompt: "Summarize native events.",
      },
    );
    const second = await executeChildSessionTool(
      claims,
      "child_session_create",
      {
        idempotencyKey: "two",
        prompt: "Check gather output.",
      },
    );
    const firstId = childId(first);
    const secondId = childId(second);

    await recordProviderEvent({
      id: `${firstId}:evt:1`,
      runId: firstId,
      threadId: claims.threadId,
      provider: "opencode",
      eventType: "child.started",
      nativeSessionId: "child-native-1",
      nativeParentSessionId: "parent-native",
      payload: { message: "started" },
    });
    await recordProviderEvent({
      id: `${firstId}:evt:2`,
      runId: firstId,
      threadId: claims.threadId,
      provider: "opencode",
      eventType: "child.completed",
      nativeSessionId: "child-native-1",
      nativeParentSessionId: "parent-native",
      payload: { message: "done" },
    });

    const listed = await executeChildSessionTool(claims, "child_session_list", {
      limit: 1,
    });
    const listedChildren = listed.structuredContent?.children as Array<{
      id: string;
      eventRef: string;
    }>;
    expect(listedChildren).toHaveLength(1);
    const listedChild = listedChildren[0]!;
    expect([firstId, secondId]).toContain(listedChild.id);
    expect(listedChild.eventRef).toContain("skynet://runs/");

    const events = await executeChildSessionTool(
      claims,
      "child_session_events",
      {
        childRunId: firstId,
        cursor: -1,
        limit: 1,
      },
    );
    const eventRows = events.structuredContent?.events as Array<{
      eventId: string;
    }>;
    expect(eventRows).toHaveLength(1);
    expect(events.structuredContent?.nextCursor).toBe(0);
    expect(events.structuredContent?.eventRef).toBe(
      `skynet://runs/${firstId}/native-events`,
    );

    const gathered = await executeChildSessionTool(
      claims,
      "child_session_gather",
      { limit: 10 },
    );
    const gatheredChildren = gathered.structuredContent?.children as Array<{
      id: string;
      eventCount: number;
      latestEventTypes: string[];
      eventRef: string;
    }>;
    const firstGather = gatheredChildren.find((child) => child.id === firstId);
    expect(firstGather?.eventCount).toBe(2);
    expect(firstGather?.latestEventTypes).toEqual([
      "child.completed",
      "child.started",
    ]);
    expect(firstGather?.eventRef).toBe(
      `skynet://runs/${firstId}/native-events`,
    );
  });

  test("registered execution refuses disabled current runs even if called directly", async () => {
    const claims = await fixture("claude");
    const execution = await executeRegisteredGatewayTool(
      claims,
      "child_session_list",
      {},
    );
    expect(execution.matched).toBe(true);
    if (!execution.matched) throw new Error("expected registered tool match");
    expect((execution.result as { isError?: boolean }).isError).toBe(true);
  });
});
