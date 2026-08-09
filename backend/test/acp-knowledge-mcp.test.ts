import { afterEach, describe, expect, test } from "bun:test";
import { acpKnowledgeMcpServers } from "../src/engines/acp-server";
import { toolGatewayConfig } from "../src/knowledge/gateway/config";
import { verifyToolToken } from "../src/knowledge/gateway/token";
import type { EngineRunContext } from "../src/engines/types";

// Contract test for ACP↔opencode knowledge-gateway parity (Fix 5). Asserts that
// an ACP session's config CARRIES the knowledge MCP entry — with a valid,
// run-scoped token — exactly when the gateway is wired. A live claude/codex proof
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
  test("gateway UNWIRED → no MCP servers (ACP behavior unchanged)", () => {
    delete process.env.GATEWAY_PUBLIC_URL;
    expect(acpKnowledgeMcpServers(ctx())).toEqual([]);
  });

  test("legacy full-backend tunnel variable is ignored", () => {
    process.env.TOOL_GATEWAY_PUBLIC_URL = "https://full-backend.example.test";
    expect(acpKnowledgeMcpServers(ctx())).toEqual([]);
  });

  test("gateway wired + org identity → one http entry with a valid run-scoped token", () => {
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

    // The ONLY secret in the sandbox is a bearer token that decodes to the run's
    // exact identity (orgId + userId) — the trust boundary opencode also uses.
    const auth = s.headers.find((h) => h.name === "Authorization");
    expect(auth?.value.startsWith("Bearer ")).toBe(true);
    const claims = verifyToolToken(auth!.value.slice("Bearer ".length));
    expect(claims).not.toBeNull();
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
});
