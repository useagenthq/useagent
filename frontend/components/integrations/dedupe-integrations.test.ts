import { describe, expect, test } from "bun:test";
import { dedupeIntegrations, type ConnectableSummary } from "./dedupe-integrations";

function summary(over: Partial<ConnectableSummary> & { provider: string }): ConnectableSummary {
  return { managed: false, status: "not_connected", connection: null, ...over };
}

describe("dedupeIntegrations", () => {
  test("collapses a duplicate provider, connected wins (the Apps bug)", () => {
    const out = dedupeIntegrations([
      summary({ provider: "github", connection: null }),
      summary({ provider: "github", connection: { status: "connected" } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].connection?.status).toBe("connected");
  });

  test("keeps the connected row when it comes first", () => {
    const out = dedupeIntegrations([
      summary({ provider: "github", connection: { status: "connected" } }),
      summary({ provider: "github", connection: null }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].connection?.status).toBe("connected");
  });

  test("keeps every persisted connection lifecycle state over an unavailable managed row", () => {
    for (const status of [
      "connected",
      "reauth_required",
      "unhealthy",
      "connecting",
      "revoked",
    ]) {
      const out = dedupeIntegrations([
        summary({ provider: "github", managed: true, status: "unavailable" }),
        summary({ provider: "github", connection: { status } }),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].connection?.status).toBe(status);
    }
  });

  test("preserves distinct providers and their original order", () => {
    const out = dedupeIntegrations([
      summary({ provider: "slack" }),
      summary({ provider: "github", connection: { status: "connected" } }),
      summary({ provider: "gmail" }),
      summary({ provider: "github" }),
    ]);
    expect(out.map((s) => s.provider)).toEqual(["slack", "github", "gmail"]);
  });

  test("treats a managed+connected backend as connected", () => {
    const out = dedupeIntegrations([
      summary({ provider: "notion" }),
      summary({ provider: "notion", managed: true, status: "connected" }),
    ]);
    expect(out).toHaveLength(1);
    expect(isConnected(out[0])).toBe(true);
  });

  test("leaves an already-unique list unchanged", () => {
    const input = [summary({ provider: "slack" }), summary({ provider: "gmail" })];
    expect(dedupeIntegrations(input)).toHaveLength(2);
  });
});

function isConnected(s: ConnectableSummary): boolean {
  return s.connection?.status === "connected" || (s.managed && s.status === "connected");
}
