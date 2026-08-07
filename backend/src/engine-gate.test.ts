// Regression lock for the P0 engine-enablement gate (final_harness.md): the
// registered-but-unsafe Claude/Codex/ACP adapters must NOT be activatable by
// default; only an explicit ENABLED_ENGINES opt-in turns them on, and the proven
// base (opencode/mock/daytona) can never be disabled. Written before the route/
// worker enforcement changes so the intended behavior is pinned first.

import { afterEach, describe, expect, test } from "bun:test";
import { enabledEngines, isEngineEnabled } from "./env";

const orig = process.env.ENABLED_ENGINES;
afterEach(() => {
  if (orig === undefined) delete process.env.ENABLED_ENGINES;
  else process.env.ENABLED_ENGINES = orig;
});

describe("engine enablement gate (P0 security)", () => {
  test("safe default: opencode/mock/daytona ON; claude/codex/acp/claude-sdk OFF", () => {
    delete process.env.ENABLED_ENGINES;
    expect(isEngineEnabled("opencode")).toBe(true);
    expect(isEngineEnabled("mock")).toBe(true);
    expect(isEngineEnabled("daytona")).toBe(true);
    // The unsafe/unproven ACP surfaces are closed unless explicitly enabled.
    expect(isEngineEnabled("claude")).toBe(false);
    expect(isEngineEnabled("codex")).toBe(false);
    expect(isEngineEnabled("acp")).toBe(false);
    expect(isEngineEnabled("claude-sdk")).toBe(false);
  });

  test("ENABLED_ENGINES opts specific engines in, never disables the base", () => {
    process.env.ENABLED_ENGINES = "claude, codex";
    expect(isEngineEnabled("claude")).toBe(true);
    expect(isEngineEnabled("codex")).toBe(true);
    expect(isEngineEnabled("acp")).toBe(false); // not listed
    expect(isEngineEnabled("opencode")).toBe(true); // base always on
    expect(enabledEngines().has("mock")).toBe(true);
  });

  test("unknown/garbage ids are ignored - no injection into the set", () => {
    process.env.ENABLED_ENGINES = "evil; rm -rf,claude,";
    expect(isEngineEnabled("claude")).toBe(true);
    expect(isEngineEnabled("evil; rm -rf")).toBe(false);
  });

  test("fail closed on an entirely unknown engine id", () => {
    delete process.env.ENABLED_ENGINES;
    expect(isEngineEnabled("totally-unknown")).toBe(false);
  });
});
