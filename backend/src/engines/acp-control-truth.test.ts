import { describe, expect, test } from "bun:test";
import { establishAcpSession, sendSessionCancel } from "./acp-server";

function fetcher(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(handler, { preconnect(): void {} });
}

describe("ACP control truthfulness", () => {
  test("cancel reports transport failure instead of fabricating success", async () => {
    await expect(sendSessionCancel(
      "https://relay.test",
      "token",
      "session-1",
      fetcher(async () => new Response("failed", { status: 503 })),
    )).resolves.toBe(false);

    await expect(sendSessionCancel(
      "https://relay.test",
      "token",
      "session-1",
      fetcher(async () => new Response(null, { status: 204 })),
    )).resolves.toBe(true);
  });

  test("fresh-session mode ignores both live and persisted session ids", async () => {
    const methods: string[] = [];
    const result = await establishAcpSession({
      liveSessionId: "live-session",
      persistedSessionId: "persisted-session",
      freshSessionOnly: true,
      cwd: "/workspace",
      mcpServers: [],
      request: async (method) => {
        methods.push(method);
        return { sessionId: "fresh-session" };
      },
    });

    expect(methods).toEqual(["session/new"]);
    expect(result).toEqual({
      sessionId: "fresh-session",
      resumed: false,
      configuredGatewayDescriptor: true,
    });
  });
});
