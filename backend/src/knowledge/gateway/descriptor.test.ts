import { afterEach, describe, expect, test } from "bun:test";
import {
  TOOL_GATEWAY_SERVER_NAME,
  buildToolGatewayCapabilityDescriptor,
  toAcpKnowledgeMcpServer,
  toCodexToolGatewayConfig,
  toOpenCodeKnowledgeMcpEntry,
} from "./descriptor";
import { verifyToolToken } from "./token";

const original = { ...process.env };

afterEach(() => {
  for (const name of [
    "GATEWAY_PUBLIC_URL",
    "TOOL_GATEWAY_PUBLIC_URL",
    "TOOL_GATEWAY_SECRET",
    "TOOL_GATEWAY_TOKEN_TTL_MS",
  ]) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("tool gateway capability descriptor", () => {
  test("fails closed without configured gateway or org identity", () => {
    delete process.env.GATEWAY_PUBLIC_URL;
    expect(buildToolGatewayCapabilityDescriptor({
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-a",
      runId: "run-a",
    })).toBeNull();

    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    expect(buildToolGatewayCapabilityDescriptor({
      orgId: null,
      userId: "user-a",
      threadId: "thread-a",
      runId: "run-a",
    })).toBeNull();
  });

  test("mints a short-lived descriptor with explicit tenant and run binding", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test/";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_TOKEN_TTL_MS = "60000";

    const descriptor = buildToolGatewayCapabilityDescriptor(
      {
        orgId: "org-a",
        userId: "user-a",
        threadId: "thread-a",
        runId: "run-a",
      },
      { scope: "thread", nowMs: 1_000_000 },
    );

    expect(descriptor).not.toBeNull();
    expect(descriptor!.serverName).toBe(TOOL_GATEWAY_SERVER_NAME);
    expect(descriptor!.url).toBe("https://gateway.example.test/api/mcp/knowledge");
    expect(descriptor!.authorizationHeader).toBe(`Bearer ${descriptor!.bearerToken}`);
    expect(descriptor!.expiresAt).toBe(1_060_000);
    expect(descriptor!.binding).toEqual({
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-a",
      runId: "run-a",
      scope: "thread",
    });

    expect(verifyToolToken(descriptor!.bearerToken, 1_000_000)).toMatchObject({
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-a",
      runId: "run-a",
      scope: "thread",
      exp: 1_060_000,
    });
  });

  test("does not let a caller extend a token beyond the configured TTL", () => {
    const config = {
      publicUrl: "https://gateway.example.test",
      mcpUrl: "https://gateway.example.test/api/mcp/knowledge",
      tokenTtlMs: 60_000,
    };

    const descriptor = buildToolGatewayCapabilityDescriptor(
      {
        orgId: "org-a",
        userId: "user-a",
        threadId: "thread-a",
        runId: "run-a",
      },
      { config, ttlMs: 120_000, nowMs: 1_000_000 },
    );

    expect(descriptor?.expiresAt).toBe(1_060_000);
    expect(verifyToolToken(descriptor?.bearerToken, 1_000_000)?.exp).toBe(1_060_000);
  });

  test("formats the same descriptor for ACP, OpenCode, and native Codex", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";

    const descriptor = buildToolGatewayCapabilityDescriptor(
      {
        orgId: "org-a",
        userId: "",
        runId: "run-a",
      },
      { nowMs: 1_000_000 },
    );

    expect(descriptor).not.toBeNull();
    expect(descriptor!.binding).toMatchObject({
      threadId: "run-a",
      scope: "run",
    });
    expect(toAcpKnowledgeMcpServer(descriptor!)).toEqual({
      type: "http",
      name: "skynet-knowledge",
      url: "https://gateway.example.test/api/mcp/knowledge",
      headers: [{ name: "Authorization", value: descriptor!.authorizationHeader }],
    });
    expect(toOpenCodeKnowledgeMcpEntry(descriptor!)).toEqual({
      type: "remote",
      url: "https://gateway.example.test/api/mcp/knowledge",
      enabled: true,
      headers: { Authorization: descriptor!.authorizationHeader },
    });
    expect(toCodexToolGatewayConfig(descriptor!)).toEqual({
      url: "https://gateway.example.test/api/mcp/knowledge",
      bearerToken: descriptor!.bearerToken,
    });
  });
});
