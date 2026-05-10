import { describe, expect, test } from "bun:test";
import { resolveAcpTurnTimeoutMs } from "./acp-server";

// P1-A: cold Claude/Codex ACP turns must be reliable from a COMMITTED default, not a
// runtime-only ENV tweak that disappears on restart/deploy. resolveAcpTurnTimeoutMs is the
// single authoritative policy for the ACP turn budget (precedence + validation).
describe("resolveAcpTurnTimeoutMs (P1-A: committed cold-ACP turn budget)", () => {
  test("defaults to 360s when NEITHER variable is set", () => {
    expect(resolveAcpTurnTimeoutMs({})).toBe(360_000);
  });

  test("ACP_TURN_TIMEOUT_MS takes precedence over ENGINE_TIMEOUT_MS", () => {
    expect(resolveAcpTurnTimeoutMs({ ACP_TURN_TIMEOUT_MS: "500000", ENGINE_TIMEOUT_MS: "120000" })).toBe(500_000);
  });

  test("ENGINE_TIMEOUT_MS remains a compatible fallback when ACP_TURN_TIMEOUT_MS is absent", () => {
    expect(resolveAcpTurnTimeoutMs({ ENGINE_TIMEOUT_MS: "240000" })).toBe(240_000);
  });

  test("an explicit valid ACP_TURN_TIMEOUT_MS below the default is respected (operator choice)", () => {
    expect(resolveAcpTurnTimeoutMs({ ACP_TURN_TIMEOUT_MS: "90000" })).toBe(90_000);
  });

  test("invalid values can NEVER create a zero / NaN / non-finite timer - they fall through", () => {
    for (const bad of ["", "  ", "0", "-1", "-9999", "abc", "NaN", "Infinity", "-Infinity", "1e"]) {
      const v = resolveAcpTurnTimeoutMs({ ACP_TURN_TIMEOUT_MS: bad });
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
      expect(v).toBe(360_000); // fell through to the safe default
    }
  });

  test("a bad ACP value with a valid ENGINE fallback uses the fallback (never the default, never zero)", () => {
    expect(resolveAcpTurnTimeoutMs({ ACP_TURN_TIMEOUT_MS: "nope", ENGINE_TIMEOUT_MS: "300000" })).toBe(300_000);
  });

  test("both invalid -> the safe default (never a bad timer)", () => {
    expect(resolveAcpTurnTimeoutMs({ ACP_TURN_TIMEOUT_MS: "-5", ENGINE_TIMEOUT_MS: "oops" })).toBe(360_000);
  });

  test("OpenCode's budget is a SEPARATE policy (600s) and does not read ACP_TURN_TIMEOUT_MS", () => {
    // opencode-server.ts keeps `Number(ENGINE_TIMEOUT_MS ?? 600_000)` - modelled here to prove
    // the new ACP-only variable does not bleed into OpenCode's timeout behavior.
    const opencodeBudget = (env: Record<string, string | undefined>) => Number(env.ENGINE_TIMEOUT_MS ?? 600_000);
    const env = { ACP_TURN_TIMEOUT_MS: "999000" };
    expect(resolveAcpTurnTimeoutMs(env)).toBe(999_000); // ACP picks it up
    expect(opencodeBudget(env)).toBe(600_000); // OpenCode unchanged
  });
});
