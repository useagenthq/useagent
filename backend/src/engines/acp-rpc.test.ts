// Slice 3 gate: the ACP relay transport is resilient. A request settles PROMPTLY
// when the event pump dies (no hang until the turn timeout), cleanup is idempotent
// with no pending left, and a resident-agent restart never reuses a stale session id.

import { describe, expect, test } from "bun:test";
import { AcpRelayError, createAcpRpcClient, liveSessionAfterBoot, type JsonRpcMessage } from "./acp-rpc";

describe("acp-rpc: disconnect hang fix", () => {
  test("failAll rejects EVERY pending request with a stable relay_disconnected code", async () => {
    const sent: JsonRpcMessage[] = [];
    const rpc = createAcpRpcClient(async (m) => { sent.push(m); });

    const a = rpc.request("session/prompt", { x: 1 });
    const b = rpc.request("initialize", {});
    expect(rpc.pendingCount).toBe(2);
    expect(sent).toHaveLength(2);

    // Simulate the event pump dying before any response.
    rpc.failAll("relay_disconnected", "ACP relay event stream ended before response");

    for (const p of [a, b]) {
      // Promptly rejected (no timeout wait), with the classified error + code.
      await expect(p).rejects.toBeInstanceOf(AcpRelayError);
      await p.catch((e: AcpRelayError) => expect(e.code).toBe("relay_disconnected"));
    }
    expect(rpc.pendingCount).toBe(0);
  });

  test("failAll is idempotent - a second call with nothing pending is a no-op", () => {
    const rpc = createAcpRpcClient(async () => {});
    rpc.failAll("relay_disconnected", "x");
    expect(() => rpc.failAll("relay_disconnected", "again")).not.toThrow();
    expect(rpc.pendingCount).toBe(0);
  });

  test("a send-transport failure rejects that request (relay_disconnected), leaves others", async () => {
    let calls = 0;
    const rpc = createAcpRpcClient(async () => {
      calls++;
      if (calls === 1) throw new Error("HTTP 502");
    });
    const failed = rpc.request("session/prompt", {});
    const ok = rpc.request("initialize", {});
    await expect(failed).rejects.toMatchObject({ code: "relay_disconnected" });
    // The second request has no response yet, so it is still pending (not collateral).
    expect(rpc.pendingCount).toBe(1);
    rpc.dispatch({ jsonrpc: "2.0", id: 2, result: { ok: true } });
    await expect(ok).resolves.toEqual({ ok: true });
    expect(rpc.pendingCount).toBe(0);
  });
});

describe("acp-rpc: dispatch correlation", () => {
  test("a matching result resolves; the pending entry is removed", async () => {
    const rpc = createAcpRpcClient(async () => {});
    const p = rpc.request("session/new", {});
    expect(rpc.dispatch({ jsonrpc: "2.0", id: 1, result: { sessionId: "ses_1" } })).toBe(true);
    await expect(p).resolves.toEqual({ sessionId: "ses_1" });
    expect(rpc.pendingCount).toBe(0);
  });

  test("an error response rejects with provider_error", async () => {
    const rpc = createAcpRpcClient(async () => {});
    const p = rpc.request("session/prompt", {});
    rpc.dispatch({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } });
    await expect(p).rejects.toMatchObject({ code: "provider_error" });
  });

  test("a message that is not an awaited response returns false (caller handles it)", () => {
    const rpc = createAcpRpcClient(async () => {});
    void rpc.request("initialize", {});
    // notification (no id), server->client request (id but method, no result), and an
    // unknown response id all return false so the pump routes them itself.
    expect(rpc.dispatch({ jsonrpc: "2.0", method: "session/update", params: {} })).toBe(false);
    expect(rpc.dispatch({ jsonrpc: "2.0", id: 99, method: "session/request_permission" })).toBe(false);
    expect(rpc.dispatch({ jsonrpc: "2.0", id: 42, result: {} })).toBe(false);
  });
});

describe("acp-rpc: restart-generation session guard", () => {
  test("a relay reboot invalidates the in-memory session id (never reuse a stale one)", () => {
    expect(liveSessionAfterBoot("ses_live", true)).toBeNull();
    expect(liveSessionAfterBoot("ses_live", false)).toBe("ses_live");
  });
  test("no live session is unaffected by the reboot flag", () => {
    expect(liveSessionAfterBoot(null, true)).toBeNull();
    expect(liveSessionAfterBoot(null, false)).toBeNull();
  });
});
