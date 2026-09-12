import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveRetainedSandbox, reviveRetainedSandbox, RetainedSandboxRuntimeMismatchError, sandboxHasRequiredLabels } from "./thread-sandbox";
import type { EngineRunContext } from "./types";
import type { SandboxHandle } from "../sandboxes/provider";
import type { SandboxBinding } from "../sandboxes/binding";

describe("shared thread sandbox lease", () => {
  test("persists the run mapping before returning a sandbox to an engine", () => {
    const source = readFileSync(new URL("./thread-sandbox.ts", import.meta.url), "utf8");
    const persist = source.indexOf("await persistSandboxBeforeExecution({");
    const returned = source.indexOf("return {\n    sandbox,");
    expect(persist).toBeGreaterThan(0);
    expect(returned).toBeGreaterThan(persist);
  });

  test("preserves files and mapping when retained credentials require migration", async () => {
    const files = new Map([["draft.txt", "unpublished work"]]);
    let forgotten = 0;
    let deleted = 0;
    const sandbox = {
      id: "credential-old", state: "started",
      delete: async () => { deleted++; files.clear(); },
    } as unknown as SandboxHandle;
    const binding = { kind: "cube", provider: { get: async () => sandbox } } as unknown as SandboxBinding;
    await expect(resolveRetainedSandbox(
      { threadId: "credential-thread", orgId: "org" } as EngineRunContext,
      { snapshot: "native", chip: "runtime:codex" },
      {
        getSandboxId: async () => sandbox.id,
        revive: (ctx, id, options) => reviveRetainedSandbox(ctx, id, options, {
          threadBinding: async () => binding,
          sandboxBinding: async () => binding,
          credentialsCurrent: async () => false,
        }),
        forget: () => { forgotten++; },
      },
    )).rejects.toThrow("credential-isolation");
    expect(deleted).toBe(0);
    expect(forgotten).toBe(0);
    expect(files.get("draft.txt")).toBe("unpublished work");
  });

  test("does not discard a retained workspace to satisfy a larger resource target", async () => {
    let deleted = 0;
    let forgotten = 0;
    const sandbox = { id: "small-retained", cpu: 2, memory: 4, delete: async () => { deleted++; } } as unknown as SandboxHandle;
    await expect(resolveRetainedSandbox(
      { threadId: "resource-thread" } as EngineRunContext,
      { snapshot: "native", chip: "runtime:codex", minimumResources: { cpu: 4, memory: 8 } },
      {
        getSandboxId: async () => sandbox.id,
        revive: async () => ({ sandbox, binding: { kind: "cube" } as SandboxBinding }),
        forget: () => { forgotten++; },
      },
    )).rejects.toThrow("resource upgrade");
    expect(deleted).toBe(0);
    expect(forgotten).toBe(0);
  });

  test("preserves unpublished workspace data on incompatible upgrade and rollback", async () => {
    const required = { "useagent.runtime": "useagent-runtime-v8" };
    expect(sandboxHasRequiredLabels({ labels: required }, required)).toBe(true);
    for (const generation of ["useagent-runtime-v7", "useagent-runtime-v9"]) {
      const files = new Map([["draft.txt", "unpublished work"]]);
      let deleted = 0;
      let forgotten = 0;
      const sandbox = {
        id: "retained-sandbox",
        labels: { "useagent.runtime": generation },
        delete: async () => { deleted++; files.clear(); },
      } as unknown as SandboxHandle;
      await expect(resolveRetainedSandbox(
        { threadId: "thread-preserved" } as EngineRunContext,
        { snapshot: "native", chip: "runtime:codex", requiredLabels: required },
        {
          getSandboxId: async () => sandbox.id,
          revive: async () => ({ sandbox, binding: { kind: "cube" } as SandboxBinding }),
          forget: () => { forgotten++; },
        },
      )).rejects.toBeInstanceOf(RetainedSandboxRuntimeMismatchError);
      expect(deleted).toBe(0);
      expect(forgotten).toBe(0);
      expect(files.get("draft.txt")).toBe("unpublished work");
    }
  });

  test("reuses a compatible retained workspace without replacing its identity", async () => {
    const sandbox = { id: "existing", labels: { "useagent.runtime": "useagent-runtime-v8" } } as unknown as SandboxHandle;
    const binding = { kind: "box" } as SandboxBinding;
    const result = await resolveRetainedSandbox(
      { threadId: "thread-preserved" } as EngineRunContext,
      { snapshot: "native", chip: "runtime:codex", requiredLabels: sandbox.labels },
      { getSandboxId: async () => sandbox.id, revive: async () => ({ sandbox, binding }), forget: () => {} },
    );
    expect(result?.sandbox).toBe(sandbox);
    expect(result?.binding).toBe(binding);
  });

  test("records a named warm-pool claim as reuse", () => {
    const source = readFileSync(new URL("./thread-sandbox.ts", import.meta.url), "utf8");
    expect(source).toContain("claimCubeWarmSandbox(options.warmPool || undefined)");
    expect(source).toContain("reused = sandbox !== null");
  });

  test("records standardized sandbox acquisition timing outcomes", () => {
    const source = readFileSync(new URL("./thread-sandbox.ts", import.meta.url), "utf8");
    expect(source).toContain("RUN_TIMING_STAGES.sandboxRetained");
    expect(source).toContain("RUN_TIMING_STAGES.sandboxWarmPool");
    expect(source).toContain("RUN_TIMING_STAGES.sandboxCreate");
    expect(source).toContain("RUN_TIMING_OUTCOMES.hit");
    expect(source).toContain("RUN_TIMING_OUTCOMES.miss");
    expect(source).toContain("RUN_TIMING_OUTCOMES.success");
    expect(source).toContain("RUN_TIMING_OUTCOMES.failure");
  });
});
