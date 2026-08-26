import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sandboxHasRequiredLabels } from "./thread-sandbox";

describe("shared thread sandbox lease", () => {
  test("persists the run mapping before returning a sandbox to an engine", () => {
    const source = readFileSync(new URL("./thread-sandbox.ts", import.meta.url), "utf8");
    const persist = source.indexOf("await persistSandboxBeforeExecution({");
    const returned = source.indexOf("return {\n    sandbox,");
    expect(persist).toBeGreaterThan(0);
    expect(returned).toBeGreaterThan(persist);
  });

  test("rejects obsolete retained credential generations", () => {
    const source = readFileSync(new URL("./thread-sandbox.ts", import.meta.url), "utf8");
    expect(source).toContain("providerGatewaySandboxIsCurrent(sandbox)");
    expect(source).toContain("sandbox.delete().catch");
  });

  test("rejects retained sandboxes from an older runtime generation", () => {
    const required = { "useagent.runtime": "useagent-runtime-v4" };
    expect(sandboxHasRequiredLabels({
      labels: { "skynet.runtime": "t3-v3" },
    }, required)).toBe(false);
    expect(sandboxHasRequiredLabels({ labels: required }, required)).toBe(true);

    const source = readFileSync(new URL("./thread-sandbox.ts", import.meta.url), "utf8");
    expect(source).toContain("sandbox.delete().catch");
    expect(source).toContain("retained sandbox does not match the requested runtime generation");
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
