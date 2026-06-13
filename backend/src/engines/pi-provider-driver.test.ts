import { describe, expect, test } from "bun:test";
import type { HarnessSession } from "@useagent/agent-harness/canonical";
import { makePiProviderDriver } from "./pi-provider-driver";
import { PI_BRIDGE_GENERATION } from "./pi-runtime-config";

function harnessSession(nativeSessionId = "/sessions/pi.jsonl"): HarnessSession {
  return {
    provider: "pi",
    nativeSessionId,
    runtime: { kind: "sandbox", id: "box" },
    protocolVersion: "oh-my-pi-rpc/18.0.3",
    capabilities: {} as never,
    generation: PI_BRIDGE_GENERATION,
  };
}

describe("Pi provider driver", () => {
  test("advertises constrained native tools with no product approval mediation", () => {
    const driver = makePiProviderDriver();
    expect(driver.descriptor.tools).toEqual({ mode: "provider_native", approval: "none" });
    expect(driver.descriptor.capabilities.approvals).toBe(false);
  });

  test("resumes a persistent native session and forwards follow-up prompts", async () => {
    const commands: unknown[] = [];
    const bridge = {
      sessionId: "pi-id",
      sessionFile: "/sessions/pi.jsonl",
      sandboxId: "box",
      fingerprint: "fingerprint",
      subscribe: () => () => {},
      command: async (command: unknown) => { commands.push(command); },
      dispose: async () => {},
    };
    const driver = makePiProviderDriver({
      resolveRuntime: async () => ({ id: "box" } as never),
      bridges: {
        ensure: async (input) => {
          expect(input.resumeSessionFile).toBe("/sessions/pi.jsonl");
          return bridge;
        },
        get: () => bridge,
        remove: async () => {},
      },
    });
    const resumed = await driver.resume({
      session: harnessSession(),
      metadata: {
        workdir: "/root/work",
        runtime: {
          fingerprint: "fingerprint",
          knowledgeTools: true,
          model: { provider: "openai", modelId: "gpt", selector: "openai/gpt" },
          executable: "/opt/useagent/pi-runtime/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
          bunExecutable: "/opt/useagent/pi-runtime/bin/bun",
          runAsUser: "useagent-pi",
          home: "/home/useagent-pi",
        },
      },
    });
    expect(resumed.status).toBe("ok");
    await driver.steer({
      runId: "run",
      threadId: "thread",
      session: harnessSession(),
      input: { kind: "prompt", text: "continue" },
    });
    expect(commands).toEqual([{ kind: "prompt", text: "continue", model: undefined }]);
  });

  test("cancels the exact live Pi session", async () => {
    const commands: unknown[] = [];
    const bridge = {
      sessionId: "pi-id",
      sessionFile: "/sessions/pi.jsonl",
      sandboxId: "box",
      fingerprint: "fingerprint",
      subscribe: () => () => {},
      command: async (command: unknown) => { commands.push(command); },
      dispose: async () => {},
    };
    const driver = makePiProviderDriver({
      resolveRuntime: async () => null,
      bridges: { ensure: async () => bridge, get: () => bridge, remove: async () => {} },
    });
    expect(await driver.cancel(harnessSession(), "user stopped")).toEqual({ status: "ok" });
    expect(commands).toEqual([{ kind: "cancel", reason: "user stopped" }]);
  });

  test("removes the native bridge when Pi rejects cancellation", async () => {
    const removed: string[] = [];
    const bridge = {
      sessionId: "pi-id",
      sessionFile: "/sessions/pi.jsonl",
      sandboxId: "box",
      fingerprint: "fingerprint",
      subscribe: () => () => {},
      command: async () => { throw new Error("abort rejected"); },
      dispose: async () => {},
    };
    const driver = makePiProviderDriver({
      resolveRuntime: async () => null,
      bridges: {
        ensure: async () => bridge,
        get: () => bridge,
        remove: async (sessionFile) => { removed.push(sessionFile); },
      },
    });

    expect(await driver.cancel(harnessSession(), "user stopped")).toEqual({
      status: "error",
      code: "cancel_failed",
      message: "abort rejected",
    });
    expect(removed).toEqual(["/sessions/pi.jsonl"]);
  });
});
