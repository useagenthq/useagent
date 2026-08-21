import { afterEach, describe, expect, test } from "bun:test";
import {
  acpGatewayDescriptorNeedsRefresh,
  acpGatewayTokenNeedsRefresh,
  acpKnowledgeMcpServers,
  acpMcpServerToolCount,
  awaitAcpMcpServerTools,
  establishAcpSession,
  refreshAcpRelayConfigurationIfNeeded,
} from "../src/engines/acp-server";
import { toolGatewayConfig } from "../src/knowledge/gateway/config";
import { verifyToolToken } from "../src/knowledge/gateway/token";
import type { EngineRunContext } from "../src/engines/types";

// Contract test for ACP↔opencode knowledge-gateway parity (Fix 5). Asserts that
// an ACP session's config CARRIES the knowledge MCP entry — with a valid,
// thread-scoped token — exactly when the gateway is wired. A live claude/codex proof
// is NOT possible here (those engines are disabled), so this pins the config the
// adapter passes into session/new + session/load.

function ctx(over: Partial<EngineRunContext> = {}): EngineRunContext {
  return {
    runId: "run-1",
    prompt: "",
    bootstrapContext: "",
    turnContext: "",
    workdir: "/tmp/work",
    orgId: "org-acme",
    userId: "user-7",
    threadId: "thread-1",
    signal: new AbortController().signal,
    emit: async () => undefined,
    setSummary: () => {},
    ...over,
  };
}

afterEach(() => {
  delete process.env.GATEWAY_PUBLIC_URL;
  delete process.env.TOOL_GATEWAY_PUBLIC_URL;
  delete process.env.TOOL_GATEWAY_SECRET;
});

describe("ACP knowledge MCP parity", () => {
  test("parses only the exact server's nonzero tool catalog from Codex /mcp status", () => {
    const status = [
      "Configured MCP servers:",
      "- unrelated: 3 tools, 0 resources, auth=not_required",
      "- skynet-knowledge: 17 tools, 0 resources, auth=not_required",
      "- skynet-knowledge",
    ].join("\n");

    expect(acpMcpServerToolCount(status, "skynet-knowledge")).toBe(17);
    expect(acpMcpServerToolCount(status, "unrelated")).toBe(3);
    expect(acpMcpServerToolCount(status, "missing")).toBeNull();
  });

  test("waits for Codex's asynchronous MCP startup before the first real prompt", async () => {
    const statuses = [
      "Configured MCP servers:\n- skynet-knowledge: 0 tools, 0 resources, auth=not_required",
      "Configured MCP servers:\n- skynet-knowledge",
      "Configured MCP servers:\n- skynet-knowledge: 21 tools, 0 resources, auth=not_required",
    ];
    const waits: number[] = [];

    const count = await awaitAcpMcpServerTools({
      serverName: "skynet-knowledge",
      attempts: 3,
      intervalMs: 25,
      readStatus: async () => statuses.shift() ?? "",
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });

    expect(count).toBe(21);
    expect(waits).toEqual([25, 25]);
  });

  test("fails closed when Codex never reports a usable MCP tool catalog", async () => {
    await expect(
      awaitAcpMcpServerTools({
        serverName: "skynet-knowledge",
        attempts: 2,
        intervalMs: 1,
        readStatus: async () =>
          "Configured MCP servers:\n- skynet-knowledge: 0 tools, 0 resources, auth=not_required",
        wait: async () => {},
      }),
    ).rejects.toThrow("skynet-knowledge MCP tools did not become ready");
  });

  test("gateway UNWIRED → no MCP servers (ACP behavior unchanged)", () => {
    delete process.env.GATEWAY_PUBLIC_URL;
    expect(acpKnowledgeMcpServers(ctx())).toEqual([]);
  });

  test("legacy full-backend tunnel variable is ignored", () => {
    process.env.TOOL_GATEWAY_PUBLIC_URL = "https://full-backend.example.test";
    expect(acpKnowledgeMcpServers(ctx())).toEqual([]);
  });

  test("gateway wired + org identity → one http entry with a valid thread-scoped token", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gw.example.test";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef0123";
    const servers = acpKnowledgeMcpServers(
      ctx({ orgId: "org-acme", userId: "user-7", threadId: "thread-1", runId: "run-1" }),
    );
    expect(servers).toHaveLength(1);
    const s = servers[0] as {
      type: string;
      name: string;
      url: string;
      headers: { name: string; value: string }[];
    };
    // Same URL the opencode path targets.
    expect(s.type).toBe("http");
    expect(s.name).toBe("skynet-knowledge");
    expect(s.url).toBe(toolGatewayConfig()!.mcpUrl);

    // The ONLY secret in the sandbox is a bearer token for this org/thread. ACP
    // resident sessions may retain it across warm turns by this same user, so the
    // gateway resolves the current running run server-side on each call.
    const auth = s.headers.find((h) => h.name === "Authorization");
    expect(auth?.value.startsWith("Bearer ")).toBe(true);
    const claims = verifyToolToken(auth!.value.slice("Bearer ".length));
    expect(claims).not.toBeNull();
    expect(claims!.scope).toBe("thread");
    expect(claims!.orgId).toBe("org-acme");
    expect(claims!.userId).toBe("user-7");
    expect(claims!.threadId).toBe("thread-1");
    expect(claims!.runId).toBe("run-1");
  });

  test("gateway wired but run has NO org → fail closed (no entry, no unscoped token)", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gw.example.test";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef0123";
    expect(acpKnowledgeMcpServers(ctx({ orgId: null }))).toEqual([]);
  });

  test("refreshes a resident descriptor before its token can expire mid-turn", () => {
    const now = 1_000_000;
    expect(acpGatewayTokenNeedsRefresh(now + 500_000, 360_000, now)).toBe(false);
    expect(acpGatewayTokenNeedsRefresh(now + 420_000, 360_000, now)).toBe(true);
    expect(acpGatewayTokenNeedsRefresh(null, 360_000, now)).toBe(true);
  });

  test("URL, user, and expiry changes force a resident descriptor refresh", () => {
    const now = 1_000_000;
    const current = {
      mcpGatewayUrl: "https://gw.example.test/api/mcp/knowledge",
      mcpUserId: "user-a",
      mcpTokenExpiresAt: now + 1_000_000,
    };
    const desired = {
      gatewayUrl: "https://gw.example.test/api/mcp/knowledge",
      userId: "user-a",
    };

    expect(acpGatewayDescriptorNeedsRefresh(current, desired, 360_000, now)).toBe(false);
    expect(
      acpGatewayDescriptorNeedsRefresh(
        current,
        { ...desired, gatewayUrl: "https://gw-2.example.test/api/mcp/knowledge" },
        360_000,
        now,
      ),
    ).toBe(true);
    expect(
      acpGatewayDescriptorNeedsRefresh(
        current,
        { ...desired, userId: "user-b" },
        360_000,
        now,
      ),
    ).toBe(true);
    expect(
      acpGatewayDescriptorNeedsRefresh(
        { ...current, mcpTokenExpiresAt: now + 420_000 },
        desired,
        360_000,
        now,
      ),
    ).toBe(true);
  });

  test("a retained relay restarts before session/load installs the new user's descriptor", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gw.example.test";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef0123";

    let stops = 0;
    const restarted = await refreshAcpRelayConfigurationIfNeeded({
      retainForThread: true,
      secretChanged: false,
      reconnectingToResidentProcess: false,
      providerModelChanged: false,
      descriptor: {
        mcpGatewayUrl: "https://gw.example.test/api/mcp/knowledge",
        mcpUserId: "user-a",
        mcpTokenExpiresAt: Date.now() + 1_000_000,
      },
      desiredGatewayUrl: "https://gw.example.test/api/mcp/knowledge",
      desiredGatewayUserId: "user-b",
      turnBudgetMs: 360_000,
      stopRelay: async () => {
        stops += 1;
      },
    });
    expect(restarted).toBe(true);
    expect(stops).toBe(1);

    const currentUserServers = acpKnowledgeMcpServers(
      ctx({ userId: "user-b", runId: "run-2" }),
    );
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = await establishAcpSession({
      liveSessionId: null,
      persistedSessionId: "session-1",
      cwd: "/root/work",
      mcpServers: currentUserServers,
      request: async (method, params) => {
        requests.push({ method, params });
        return {};
      },
    });

    expect(session).toEqual({
      sessionId: "session-1",
      resumed: true,
      configuredGatewayDescriptor: true,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("session/load");
    const params = requests[0]?.params as {
      sessionId: string;
      cwd: string;
      mcpServers: Array<{ headers: Array<{ name: string; value: string }> }>;
    };
    expect(params.sessionId).toBe("session-1");
    expect(params.cwd).toBe("/root/work");
    const auth = params.mcpServers[0]?.headers.find(
      (header) => header.name === "Authorization",
    );
    const claims = verifyToolToken(auth!.value.slice("Bearer ".length));
    expect(claims).toMatchObject({
      orgId: "org-acme",
      userId: "user-b",
      threadId: "thread-1",
      runId: "run-2",
      scope: "thread",
    });
  });

  test("a retained Claude relay restarts when its process model changes", async () => {
    let stops = 0;
    const restarted = await refreshAcpRelayConfigurationIfNeeded({
      retainForThread: true,
      secretChanged: false,
      reconnectingToResidentProcess: false,
      providerModelChanged: true,
      descriptor: null,
      desiredGatewayUrl: null,
      desiredGatewayUserId: null,
      turnBudgetMs: 360_000,
      stopRelay: async () => {
        stops += 1;
      },
    });

    expect(restarted).toBe(true);
    expect(stops).toBe(1);
  });
});
