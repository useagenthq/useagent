import type { HarnessRuntime, HarnessSession } from "@useagent/agent-harness/canonical";
import type {
  HarnessAdapter,
  HarnessOperationResult,
  HarnessSessionHandle,
  ProviderDriver,
  ProviderStartRequest,
} from "@useagent/agent-harness/control";
import {
  providerDriverHarnessCapabilities,
  providerDriverUnsupported,
} from "@useagent/agent-harness/control";
import { sandboxProvider, sandboxProviderApiKey, type SandboxHandle } from "../sandboxes/provider";
import { sessionCapabilities } from "./capabilities";
import {
  piBridgeManager,
  type PiBridgeManager,
  type PiBridgeSession,
} from "./pi-rpc-bridge";
import {
  PI_BRIDGE_GENERATION,
  PI_CODING_AGENT_VERSION,
  type PreparedPiRuntime,
} from "./pi-runtime-config";

interface PiStartMetadata {
  readonly workdir: string;
  readonly runtime: PreparedPiRuntime;
}

function metadata(value: Record<string, unknown> | undefined): PiStartMetadata | null {
  const workdir = value?.workdir;
  const runtime = value?.runtime as PreparedPiRuntime | undefined;
  return typeof workdir === "string" && workdir.startsWith("/") &&
    typeof runtime?.fingerprint === "string" &&
    typeof runtime?.knowledgeTools === "boolean" &&
    typeof runtime?.model?.selector === "string" &&
    typeof runtime?.executable === "string" && runtime.executable.startsWith("/") &&
    typeof runtime?.bunExecutable === "string" && runtime.bunExecutable.startsWith("/") &&
    typeof runtime?.runAsUser === "string" && runtime.runAsUser.length > 0 &&
    typeof runtime?.home === "string" && runtime.home.startsWith("/")
    ? { workdir, runtime }
    : null;
}

function error(code: string, message: string) {
  return { status: "error" as const, code, message };
}

async function resolveRuntime(runtime: HarnessRuntime): Promise<SandboxHandle | null> {
  if (runtime.kind !== "sandbox") return null;
  try {
    return await sandboxProvider(sandboxProviderApiKey()).get(runtime.id);
  } catch {
    return null;
  }
}

function canonicalSession(
  runtime: HarnessRuntime,
  bridge: PiBridgeSession,
  knowledgeTools: boolean,
): HarnessSession {
  return {
    provider: "pi",
    // Pi's persistent JSONL file is the native resume handle. The ephemeral
    // in-process session id is intentionally not durable authority.
    nativeSessionId: bridge.sessionFile,
    runtime,
    protocolVersion: `oh-my-pi-rpc/${PI_CODING_AGENT_VERSION}`,
    capabilities: sessionCapabilities("pi", {
      desktop: false,
      knowledgeTools,
    }),
    generation: PI_BRIDGE_GENERATION,
  };
}

export interface PiProviderDriverDependencies {
  readonly resolveRuntime: typeof resolveRuntime;
  readonly bridges: PiBridgeManager;
}

const defaults: PiProviderDriverDependencies = {
  resolveRuntime,
  bridges: piBridgeManager,
};

export function makePiProviderDriver(
  dependencies: PiProviderDriverDependencies = defaults,
): ProviderDriver {
  const capabilities = sessionCapabilities("pi", {
    desktop: false,
    knowledgeTools: true,
  });
  const driver: ProviderDriver = {
    provider: "pi",
    descriptor: {
      provider: "pi",
      protocol: { name: "oh-my-pi-rpc", version: PI_CODING_AGENT_VERSION },
      capabilities,
      model: { selection: "per_turn", supportsArbitraryModel: false },
      tools: { mode: "skynet_brokered", approval: "skynet" },
    },

    async start(request: ProviderStartRequest) {
      const start = metadata(request.metadata);
      if (!start) return error("invalid_start_metadata", "Pi start metadata is incomplete");
      const sandbox = await dependencies.resolveRuntime(request.runtime);
      if (!sandbox) return error("runtime_unreachable", "Pi sandbox is unreachable");
      try {
        const bridge = await dependencies.bridges.ensure({
          sandbox,
          workdir: start.workdir,
          runtime: start.runtime,
        });
        return { status: "ok", value: canonicalSession(request.runtime, bridge, start.runtime.knowledgeTools) };
      } catch (cause) {
        return error("session_create_failed", cause instanceof Error ? cause.message : "Pi start failed");
      }
    },

    async resume(request) {
      const start = metadata(request.metadata);
      if (!start) return error("invalid_start_metadata", "Pi resume metadata is incomplete");
      const sandbox = await dependencies.resolveRuntime(request.session.runtime);
      if (!sandbox) return error("runtime_unreachable", "Pi sandbox is unreachable");
      try {
        const bridge = await dependencies.bridges.ensure({
          sandbox,
          workdir: start.workdir,
          runtime: start.runtime,
          resumeSessionFile: request.session.nativeSessionId,
        });
        return {
          status: "ok",
          value: canonicalSession(request.session.runtime, bridge, start.runtime.knowledgeTools),
        };
      } catch (cause) {
        return error("session_resume_failed", cause instanceof Error ? cause.message : "Pi resume failed");
      }
    },

    async steer(request): Promise<HarnessOperationResult> {
      const bridge = dependencies.bridges.get(request.session.nativeSessionId);
      if (!bridge) return error("session_unreachable", "Pi RPC session is not live");
      try {
        if (request.input.kind === "prompt") {
          const delivery = request.metadata?.delivery;
          if (delivery === "steer") {
            await bridge.command({ kind: "steer", text: request.input.text });
          } else if (delivery === "follow_up") {
            await bridge.command({ kind: "follow_up", text: request.input.text });
          } else {
            await bridge.command({ kind: "prompt", text: request.input.text, model: request.input.model });
          }
        } else if (request.input.kind === "command") {
          const suffix = request.input.arguments?.trim();
          await bridge.command({
            kind: "prompt",
            text: `/${request.input.name}${suffix ? ` ${suffix}` : ""}`,
          });
        } else {
          return {
            status: "unsupported_capability",
            provider: "pi",
            capability: request.input.kind,
          };
        }
        return { status: "ok" };
      } catch (cause) {
        return error("steer_failed", cause instanceof Error ? cause.message : "Pi steer failed");
      }
    },

    async cancel(session, reason): Promise<HarnessOperationResult> {
      const bridge = dependencies.bridges.get(session.nativeSessionId);
      if (!bridge) return error("session_unreachable", "Pi RPC session is not live");
      try {
        await bridge.command({ kind: "cancel", reason });
        return { status: "ok" };
      } catch (cause) {
        return error("cancel_failed", cause instanceof Error ? cause.message : "Pi cancel failed");
      }
    },
  };
  return driver;
}

export const piProviderDriver = makePiProviderDriver();

function sessionFromHandle(handle: HarnessSessionHandle): HarnessSession {
  return {
    provider: "pi",
    nativeSessionId: handle.sessionId,
    runtime: { kind: "sandbox", id: handle.sandboxId },
    protocolVersion: `oh-my-pi-rpc/${PI_CODING_AGENT_VERSION}`,
    capabilities: piProviderDriver.descriptor.capabilities,
    generation: PI_BRIDGE_GENERATION,
  };
}

/** Compatibility control route used by restart recovery and stop callers that
 * still consume HarnessAdapter. Resume remains a ProviderDriver operation;
 * in-flight reconcile after a backend restart is explicitly unsupported. */
export const piHarness: HarnessAdapter = {
  provider: "pi",
  capabilities: () => providerDriverHarnessCapabilities(piProviderDriver),
  cancel(handle, reason) {
    return piProviderDriver.cancel(sessionFromHandle(handle), reason);
  },
  reconcile() {
    return Promise.resolve(providerDriverUnsupported(
      "pi",
      "reconcile",
      "Pi resumes persisted JSONL sessions on the next turn but cannot reconstruct an in-flight stream after restart",
    ));
  },
};
