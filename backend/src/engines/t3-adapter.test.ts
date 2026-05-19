import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  t3RunAdapterEnabled,
  t3RunAdapterEngineSelected,
  t3RunAdapterMode,
  t3RunAdapterSelected,
  t3RunSnapshot,
  t3RuntimeMode,
} from "./t3-adapter";

describe("T3 run adapter gate", () => {
  test("is disabled unless explicitly enabled", () => {
    expect(t3RunAdapterEnabled({})).toBe(false);
    expect(t3RunAdapterEnabled({ T3_RUN_ADAPTER_ENABLED: "true" })).toBe(true);
  });

  test("defaults an enabled adapter to explicit canary threads", () => {
    const ctx = { runId: "run-1", threadId: "thread-1" };
    expect(t3RunAdapterMode({ T3_RUN_ADAPTER_ENABLED: "true" })).toBe("canary");
    expect(t3RunAdapterSelected(ctx, { T3_RUN_ADAPTER_ENABLED: "true" })).toBe(false);
    expect(
      t3RunAdapterSelected(ctx, {
        T3_RUN_ADAPTER_ENABLED: "true",
        T3_CANARY_THREAD_IDS: "other, thread-1",
      }),
    ).toBe(true);
    expect(
      t3RunAdapterSelected(ctx, {
        T3_RUN_ADAPTER_ENABLED: "true",
        T3_RUN_ADAPTER_MODE: "all",
      }),
    ).toBe(true);
  });

  test("rejects an unknown routing mode", () => {
    expect(() => t3RunAdapterMode({ T3_RUN_ADAPTER_MODE: "maybe" })).toThrow(
      "T3_RUN_ADAPTER_MODE must be canary or all",
    );
  });

  test("can restrict an all-mode cutover to proven engines", () => {
    expect(t3RunAdapterEngineSelected("codex", {})).toBe(true);
    expect(t3RunAdapterEngineSelected("opencode", {})).toBe(true);
    expect(t3RunAdapterEngineSelected("claude", {})).toBe(false);
    expect(
      t3RunAdapterEngineSelected("codex", {
        T3_RUN_ADAPTER_ENGINES: "codex, opencode",
      }),
    ).toBe(true);
    expect(
      t3RunAdapterEngineSelected("claude", {
        T3_RUN_ADAPTER_ENGINES: "codex, opencode",
      }),
    ).toBe(false);
  });

  test("uses a separate Cube candidate template during parity testing", () => {
    expect(
      t3RunSnapshot({
        SANDBOX_PROVIDER: "cube",
        CUBE_TEMPLATE_ID: "production",
        T3_CUBE_TEMPLATE_ID: "candidate",
      }),
    ).toBe("candidate");
  });

  test("inherits the configured Daytona snapshot unless a T3 override is present", () => {
    expect(
      t3RunSnapshot({
        SANDBOX_PROVIDER: "daytona",
        DAYTONA_SNAPSHOT: "production-daytona",
      }),
    ).toBe("production-daytona");
    expect(
      t3RunSnapshot({
        SANDBOX_PROVIDER: "daytona",
        DAYTONA_SNAPSHOT: "production-daytona",
        T3_DAYTONA_SNAPSHOT: "candidate-daytona",
      }),
    ).toBe("candidate-daytona");
  });

  test("matches T3's autonomous default and validates explicit runtime modes", () => {
    expect(t3RuntimeMode({})).toBe("full-access");
    expect(t3RuntimeMode({ T3_RUNTIME_MODE: "approval-required" })).toBe("approval-required");
    expect(t3RuntimeMode({ T3_RUNTIME_MODE: "full-access" })).toBe("full-access");
    expect(() => t3RuntimeMode({ T3_RUNTIME_MODE: "unsafe-ish" })).toThrow(
      "T3_RUNTIME_MODE must be",
    );
  });

  test("keeps semantic prompt composition and native T3 activity projection", () => {
    const source = readFileSync(new URL("./t3-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain("composeTurnPrompt(ctx, threadExists)");
    expect(source).toContain("activityStep(activity)");
    expect(source).toContain("ctx.publishDelta?.(delta)");
    expect(source).toContain("warmPool: T3_CUBE_WARM_POOL_NAME");
    expect(source).toContain("requiredLabels:");
    expect(source).toContain("if (ctx.signal.aborted) await interruptActiveT3Turn(ctx, sandbox)");
    expect(source).toContain("buildT3TurnInterruptCommand(threadId, turnId)");
    expect(source).not.toContain("prompt.includes(");
    expect(source).not.toContain("keyword");
  });
});
