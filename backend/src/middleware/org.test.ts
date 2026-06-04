import { describe, expect, test } from "bun:test";
import { isPublicApiPath } from "./org";

describe("internal automation auth boundary", () => {
  test("bypasses session auth only for the exact self-authenticated bridge", () => {
    expect(isPublicApiPath("/api/internal/automation")).toBe(true);
    expect(isPublicApiPath("/api/internal/automation/anything")).toBe(false);
    expect(isPublicApiPath("/api/internal/automation-evil")).toBe(false);
    expect(isPublicApiPath("/api/internal/gateway-approval/consume")).toBe(true);
    expect(isPublicApiPath("/api/internal/gateway-approval/consume/extra")).toBe(false);
    expect(isPublicApiPath("/api/internal/github-operations")).toBe(true);
    expect(isPublicApiPath("/api/internal/github-operations/extra")).toBe(false);
    expect(isPublicApiPath("/api/internal/github-operations-evil")).toBe(false);
    expect(isPublicApiPath("/api/internal/codex-relay/one-use-capability")).toBe(true);
    expect(isPublicApiPath("/api/internal/codex-relay")).toBe(false);
    expect(isPublicApiPath("/api/internal/codex-relay-evil/token")).toBe(false);
  });
});
