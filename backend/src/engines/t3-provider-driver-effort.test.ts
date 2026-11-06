import { describe, expect, test } from "bun:test";
import type { HarnessSession } from "@useagent/agent-harness/canonical";
import { providerProtocolIdentity } from "@useagent/agent-harness/control";
import type { SandboxHandle } from "../sandboxes/provider";
import type { RuntimeEnvironmentRequest } from "./runtime-environment-client";
import { makeT3ProviderDriver } from "./t3-provider-driver";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

// The effort accepted on the run reaches the runtime's dispatch payloads: the
// thread the driver creates on start and every turn it steers.

interface Dispatched {
  readonly type: string;
  readonly modelSelection: unknown;
}

/** The dispatched command, narrowed by its `type`; the selection is compared
 *  whole by the assertions. */
function recorded(payload: Readonly<Record<string, unknown>> | undefined): Dispatched {
  const type = payload?.type;
  if (typeof type !== "string") throw new Error("dispatch payload without a type");
  return { type, modelSelection: payload?.modelSelection };
}

function recordingDriver(engine: "codex" | "claude") {
  const dispatched: Dispatched[] = [];
  const driver = makeT3ProviderDriver(engine, {
    resolveRuntime: async () => ({ id: "cube-t3-effort" }) as SandboxHandle,
    requestEnvironment: async <T>(_sandbox: SandboxHandle, request: RuntimeEnvironmentRequest) => {
      // No project or thread yet: start creates both.
      if (request.path === "/api/orchestration/shell") return { projects: [], threads: [] } as T;
      return {} as T;
    },
    dispatch: async (_sandbox, command) => {
      dispatched.push(recorded(command));
      return { sequence: dispatched.length };
    },
  });
  const session: HarnessSession = {
    provider: driver.provider,
    nativeSessionId: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
    runtime: { kind: "sandbox", id: "cube-t3-effort" },
    protocolVersion: providerProtocolIdentity(driver.descriptor.protocol),
    capabilities: driver.descriptor.capabilities,
    generation: driver.descriptor.sessionGeneration as number,
  };
  return { driver, session, dispatched };
}

describe("T3 driver reasoning effort dispatch", () => {
  test("a steered Codex turn carries the run's effort as the reasoningEffort option", async () => {
    const { driver, session, dispatched } = recordingDriver("codex");
    const result = await driver.steer({
      runId: "run-1",
      threadId: "thread-1",
      session,
      input: { kind: "prompt", text: "continue", model: "gpt-5.6-luna", reasoningEffort: "high" },
      metadata: { threadId: "thread-1" },
    });
    expect(result).toEqual({ status: "ok" });
    expect(dispatched.map((command) => command.type)).toEqual(["message.dispatch"]);
    expect(dispatched[0]?.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  test("a steered Claude Code turn carries it as the effort option; none sends no option", async () => {
    const { driver, session, dispatched } = recordingDriver("claude");
    await driver.steer({
      runId: "run-1",
      threadId: "thread-1",
      session,
      input: { kind: "prompt", text: "continue", model: "claude-opus-5", reasoningEffort: "low" },
      metadata: { threadId: "thread-1" },
    });
    await driver.steer({
      runId: "run-2",
      threadId: "thread-1",
      session,
      input: { kind: "prompt", text: "again", model: "claude-opus-5" },
      metadata: { threadId: "thread-1" },
    });
    expect(dispatched.map((command) => command.modelSelection)).toEqual([
      { instanceId: "claudeAgent", model: "claude-opus-5", options: [{ id: "effort", value: "low" }] },
      { instanceId: "claudeAgent", model: "claude-opus-5", options: [] },
    ]);
  });
});
