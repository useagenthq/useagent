import { describe, expect, test } from "bun:test";
import {
  providerProtocolIdentity,
  unsupportedProviderDriverOperations,
  validateProviderDriver,
} from "@useagent/agent-harness/control";
import {
  resolveHarness,
  resolveProviderDriver,
  resolveProviderDriverForSession,
  resolveProviderRegistration,
} from "./index";
import { t3ProviderDrivers } from "./t3-provider-driver";
import { RUNTIME_GENERATION } from "./runtime-environment";

describe("production provider registry", () => {
  test("registers every engine on a native lifecycle driver", () => {
    for (const engineId of ["claude", "claude-sdk", "codex", "daytona", "opencode", "pi"]) {
      const registration = resolveProviderRegistration(engineId);
      expect(registration).toBeDefined();
      if (!registration) continue;
      expect(validateProviderDriver(registration.driver)).toEqual({ status: "ok" });
      expect(resolveProviderDriver(engineId)).toBe(registration.driver);
    }

    expect(resolveProviderRegistration("opencode")?.execution.kind).toBe("provider");
    expect(resolveProviderRegistration("pi")?.execution.kind).toBe("provider");
    expect(resolveProviderRegistration("codex")?.execution.kind).toBe("provider");
    expect(resolveProviderRegistration("claude")?.execution.kind).toBe("provider");
    expect(resolveProviderDriver("codex")).toBe(t3ProviderDrivers.codex);
    expect(resolveProviderDriver("claude")).toBe(t3ProviderDrivers.claude);

    expect(resolveProviderDriver("opencode")).toBe(t3ProviderDrivers.opencode);
    expect(resolveProviderRegistration("acp")).toBeUndefined();
    expect(resolveProviderRegistration("daytona")).toBe(resolveProviderRegistration("opencode"));
    expect(resolveProviderRegistration("claude-sdk")).toBe(resolveProviderRegistration("claude"));
  });

  test("selected T3 turns resolve a native T3 ProviderDriver", () => {
    const driver = resolveProviderDriver(
      "codex",
      { runId: "run-t3", threadId: "thread-t3" },
      {
        T3_RUN_ADAPTER_ENABLED: "true",
        T3_RUN_ADAPTER_MODE: "all",
        T3_RUN_ADAPTER_ENGINES: "codex,opencode",
      },
    );

    expect(driver?.provider).toBe("codex");
    expect(driver?.descriptor.protocol).toEqual({
      name: "t3-orchestration",
      version: RUNTIME_GENERATION,
    });
    expect(validateProviderDriver(driver)).toEqual({ status: "ok" });
  });

  test("keeps engine protocol and grammar stable across providers and legacy flags", () => {
    const ctx = { runId: "run-provider-layout", threadId: "thread-provider-layout" };
    const legacyFlagSets = [
      {},
      { T3_RUN_ADAPTER_ENABLED: "false", ENGINE_TRANSPORT: "cli" },
      {
        T3_RUN_ADAPTER_ENABLED: "true",
        T3_RUN_ADAPTER_MODE: "all",
        T3_RUN_ADAPTER_ENGINES: "opencode",
      },
    ] as const;

    for (const env of legacyFlagSets) {
      for (const engine of ["claude", "codex", "opencode", "pi"] as const) {
        const selections = (["box", "cube", "daytona"] as const).map((kind) =>
          resolveProviderDriver(engine, ctx, env, kind)
        );
        expect(selections.every(Boolean)).toBe(true);
        expect(selections.map((driver) => driver?.descriptor.protocol)).toEqual([
          selections[0]?.descriptor.protocol,
          selections[0]?.descriptor.protocol,
          selections[0]?.descriptor.protocol,
        ]);
        expect(selections.map((driver) => driver?.descriptor.capabilities)).toEqual([
          selections[0]?.descriptor.capabilities,
          selections[0]?.descriptor.capabilities,
          selections[0]?.descriptor.capabilities,
        ]);
        expect(selections.some((driver) => driver?.descriptor.protocol.name === "acp"))
          .toBe(false);
      }
      expect(resolveProviderDriver("codex", ctx, env, "box")).toBe(t3ProviderDrivers.codex);
      expect(resolveProviderDriver("claude", ctx, env, "box")).toBe(t3ProviderDrivers.claude);
    }
    expect(resolveProviderDriver("opencode", ctx, {}, "box")).toBe(t3ProviderDrivers.opencode);
    expect(resolveProviderDriver("pi", ctx, {}, "box")?.descriptor.protocol.name)
      .toBe("oh-my-pi-rpc");
  });

  test("does not let rollout or transport flags demote Codex or Claude", () => {
    const ctx = { runId: "run-claude", threadId: "thread-claude" };
    const enabled = resolveProviderDriver("claude", ctx, {
      T3_RUN_ADAPTER_ENABLED: "true",
      T3_RUN_ADAPTER_MODE: "all",
      T3_RUN_ADAPTER_ENGINES: "claude,codex,opencode",
    });
    const excluded = resolveProviderDriver("claude", ctx, {
      T3_RUN_ADAPTER_ENABLED: "true",
      T3_RUN_ADAPTER_MODE: "all",
      T3_RUN_ADAPTER_ENGINES: "codex,opencode",
      ENGINE_TRANSPORT: "cli",
    });

    expect(enabled).toBe(t3ProviderDrivers.claude);
    expect(excluded).toBe(t3ProviderDrivers.claude);
    expect(resolveProviderDriver("codex", ctx, {})).toBe(t3ProviderDrivers.codex);
  });

  test("rejects old ACP bindings and accepts only fresh native bindings", () => {
    for (const engine of ["claude", "codex"] as const) {
      expect(resolveProviderDriverForSession(engine, {
        provider: engine,
        protocol: "acp/1",
        generation: 1,
        authEpoch: null,
      }, null)).toBeUndefined();

      const current = t3ProviderDrivers[engine];
      expect(resolveProviderDriverForSession(engine, {
        provider: engine,
        protocol: providerProtocolIdentity(current.descriptor.protocol),
        generation: current.descriptor.sessionGeneration as number,
        authEpoch: null,
      }, null)).toBe(current);
    }
  });

  test("projects T3 control capabilities from the selected lifecycle driver", () => {
    for (const engine of ["claude", "codex"] as const) {
      const capabilities = resolveHarness(engine)?.capabilities({
        provider: engine,
        sessionId: "skynet-thread-thread-t3",
        sandboxId: "cube-t3",
        protocol: providerProtocolIdentity(t3ProviderDrivers[engine].descriptor.protocol),
        generation: 2,
        authEpoch: null,
        currentAuthEpoch: null,
      });

      expect(capabilities).toMatchObject({
        resume: true,
        cancel: true,
        authoritativeHistory: true,
        childSessions: true,
        approvals: true,
        questions: true,
        reasoning: true,
        todos: true,
        patches: true,
        usage: true,
      });
    }
  });

  test("rejects stale T3 protocol and generation before control dispatch", async () => {
    for (const engine of ["claude", "codex"] as const) {
      const harness = resolveHarness(engine);
      expect(harness).toBeDefined();
      if (!harness) continue;
      for (const stale of [
        { protocol: "acp/1", generation: 1 },
        { protocol: "t3-orchestration/useagent-runtime-v6", generation: 2 },
        {
          protocol: providerProtocolIdentity(t3ProviderDrivers[engine].descriptor.protocol),
          generation: 1,
        },
        {
          protocol: providerProtocolIdentity(t3ProviderDrivers[engine].descriptor.protocol),
          generation: 2,
          authEpoch: "epoch-old",
          currentAuthEpoch: "epoch-current",
        },
      ]) {
        const handle = {
          provider: engine,
          sessionId: "skynet-thread-stale",
          sandboxId: "cube-stale",
          authEpoch: null,
          currentAuthEpoch: null,
          ...stale,
        };
        expect(harness.capabilities(handle)).toMatchObject({
          cancel: false,
          authoritativeHistory: false,
        });
        await expect(harness.cancel(handle, "stop")).resolves.toMatchObject({
          status: "unsupported_capability",
          capability: "cancel",
        });
      }
    }
  });

  test("primary native drivers retain their full lifecycle", () => {
    for (const engine of ["claude", "codex"] as const) {
      const registration = resolveProviderRegistration(engine);
      expect(registration?.driver).toBe(t3ProviderDrivers[engine]);
      if (!registration) continue;
      expect(unsupportedProviderDriverOperations(registration.driver)).toEqual([]);
      expect(registration.driver.descriptor.lifecycle.operations).toEqual([
        "start",
        "resume",
        "reconcile",
        "steer",
        "cancel",
      ]);
    }
  });
});
