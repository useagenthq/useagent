import { acpAdapter } from "./acp";
import { claudeHarness, codexHarness } from "./acp-harness";
import { acpClaudeAdapter, acpCodexAdapter } from "./acp-server";
import {
  makeOpenCodeServerAdapter,
  opencodeHarness,
  opencodeProviderDriver,
} from "./opencode-server";
import { sandboxClaudeAdapter, sandboxCodexAdapter } from "./sandbox";
import {
  makeT3Adapter,
  t3RunAdapterEngineSelected,
  t3RunAdapterSelected,
} from "./runtime-adapter";
import { T3_SESSION_GENERATION, t3ProviderDrivers } from "./t3-provider-driver";
import {
  normalizeNegotiatedCapabilities,
  type HarnessSession,
} from "@skynet/agent-harness/canonical";
import {
  providerDriverHarnessCapabilities,
  providerDriverUnsupported,
  type HarnessSessionHandle,
  type ProviderDriver,
  type ProviderDriverCapability,
} from "@skynet/agent-harness/control";
import type { EngineAdapter, EngineRunContext, HarnessAdapter } from "./types";
import { isT3ThreadSessionId, type T3EngineId } from "./runtime-orchestration";
import { sessionCapabilities } from "./capabilities";

// Build the ACP compatibility adapters before registering them beside native
// ProviderDriver execution. `mock` is NOT registered here — it
// stays the scripted worker path (worker.ts) and is the default. Every
// user-facing engine runs RESIDENT inside a per-thread sandbox:
// opencode via its own `opencode serve` (opencode-server.ts), claude/codex via
// persistent ACP agents behind the in-sandbox relay (acp-server.ts). Set
// ENGINE_TRANSPORT=cli to fall back to the per-turn CLI poll-tail runners
// (sandbox.ts) if the resident transport misbehaves. `daytona` / `claude-sdk`
// are legacy aliases so pre-consolidation rows (and their replies) still resolve.
const cliFallback = process.env.ENGINE_TRANSPORT === "cli";
const legacyClaude = cliFallback ? sandboxClaudeAdapter : acpClaudeAdapter;
const legacyCodex = cliFallback ? sandboxCodexAdapter : acpCodexAdapter;

function makeEngineAdapterCompatibilityDriver(
  provider: string,
  harnessCompatibility?: HarnessAdapter,
): ProviderDriver {
  const capabilities =
    provider === "acp"
      ? normalizeNegotiatedCapabilities({})
      : sessionCapabilities(provider, { desktop: false, knowledgeTools: false });
  const unavailable = (capability: ProviderDriverCapability) =>
    providerDriverUnsupported(
      provider,
      capability,
      `${provider} lifecycle is still owned by EngineAdapter compatibility orchestration`,
    );
  const harnessHandle = (session: HarnessSession) =>
    session.runtime.kind === "sandbox"
      ? {
          provider: session.provider,
          sessionId: session.nativeSessionId,
          sandboxId: session.runtime.id,
        }
      : null;

  return {
    provider,
    descriptor: {
      provider,
      protocol: { name: "engine-adapter-compatibility" },
      capabilities,
      model: { selection: capabilities.modelSelection ? "per_turn" : "fixed" },
      tools: { mode: "skynet_brokered", approval: "skynet" },
    },
    async start() {
      return unavailable("start");
    },
    async resume() {
      return unavailable("resume");
    },
    async reconcile(request) {
      const handle = harnessHandle(request.session);
      return harnessCompatibility && handle
        ? harnessCompatibility.reconcile(handle, request.checkpoint)
        : unavailable("reconcile");
    },
    async steer() {
      return unavailable("steer");
    },
    async cancel(session, reason) {
      const handle = harnessHandle(session);
      if (!harnessCompatibility || !handle) {
        return unavailable("cancel");
      }
      return harnessCompatibility.cancel(handle, reason);
    },
  };
}

export interface ProviderRegistration {
  readonly driver: ProviderDriver;
  readonly execution:
    | {
        readonly kind: "provider";
        readonly run: (ctx: EngineRunContext, driver: ProviderDriver) => Promise<void>;
      }
    | {
        readonly kind: "acp_compatibility";
        readonly adapter: EngineAdapter;
      };
  /** Recovery/stop view for callers that still consume HarnessAdapter. */
  readonly harnessAdapterCompatibility?: HarnessAdapter;
  /** Driver operations that the compatibility registration cannot perform losslessly. */
  readonly unsupportedDriverCapabilities: readonly ProviderDriverCapability[];
}

const acpRegistration: ProviderRegistration = {
  driver: makeEngineAdapterCompatibilityDriver("acp"),
  execution: { kind: "acp_compatibility", adapter: acpAdapter },
  unsupportedDriverCapabilities: ["start", "resume", "reconcile", "steer", "cancel"],
};
const claudeRegistration: ProviderRegistration = {
  driver: makeEngineAdapterCompatibilityDriver("claude", claudeHarness),
  execution: { kind: "acp_compatibility", adapter: legacyClaude },
  harnessAdapterCompatibility: claudeHarness,
  unsupportedDriverCapabilities: ["start", "resume", "reconcile", "steer"],
};
const codexRegistration: ProviderRegistration = {
  driver: makeEngineAdapterCompatibilityDriver("codex", codexHarness),
  execution: { kind: "acp_compatibility", adapter: legacyCodex },
  harnessAdapterCompatibility: codexHarness,
  unsupportedDriverCapabilities: ["start", "resume", "reconcile", "steer"],
};
const opencodeRegistration: ProviderRegistration = {
  driver: opencodeProviderDriver,
  execution: {
    kind: "provider",
    run: (ctx, driver) => makeOpenCodeServerAdapter(driver).run(ctx),
  },
  harnessAdapterCompatibility: opencodeHarness,
  unsupportedDriverCapabilities: [],
};

/** The production provider registry. Legacy ids point to the same registration,
 * so selection always resolves a ProviderDriver before exposing compatibility views. */
const providerRegistry: Readonly<Record<string, ProviderRegistration>> = {
  acp: acpRegistration,
  claude: claudeRegistration,
  "claude-sdk": claudeRegistration,
  codex: codexRegistration,
  daytona: opencodeRegistration,
  opencode: opencodeRegistration,
};

function isT3EngineId(provider: string): provider is T3EngineId {
  return provider === "codex" || provider === "claude" || provider === "opencode";
}

export function resolveProviderRegistration(provider: string): ProviderRegistration | undefined {
  return providerRegistry[provider];
}

export function resolveProviderDriver(
  provider: string,
  ctx?: Pick<EngineRunContext, "runId" | "threadId">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderDriver | undefined {
  const registration = resolveProviderRegistration(provider);
  if (!registration) return undefined;
  const canonicalProvider = registration.driver.provider;
  return ctx &&
    isT3EngineId(canonicalProvider) &&
    t3RunAdapterEngineSelected(canonicalProvider, env) &&
    t3RunAdapterSelected(ctx, env)
    ? t3ProviderDrivers[canonicalProvider]
    : registration.driver;
}

/** Authoritative production turn dispatch. Provider-native turns receive the
 * resolved lifecycle driver; only registrations explicitly marked ACP compatibility
 * may fall back to EngineAdapter.run. */
export async function runProviderTurn(
  provider: string,
  ctx: EngineRunContext,
): Promise<boolean> {
  const registration = resolveProviderRegistration(provider);
  const driver = resolveProviderDriver(provider, ctx);
  if (!registration || !driver) return false;

  if (driver.descriptor.protocol.name === "t3-orchestration") {
    if (!isT3EngineId(driver.provider)) {
      throw new Error(`Engine driver has unsupported provider '${driver.provider}'`);
    }
    await makeT3Adapter(driver.provider, driver).run(ctx);
    return true;
  }

  if (registration.execution.kind === "provider") {
    await registration.execution.run(ctx, driver);
    return true;
  }
  await registration.execution.adapter.run(ctx);
  return true;
}

/** Resolve the control adapter for a provider/engine id, or undefined if none is
 *  registered (e.g. the legacy generic `acp` or `mock`). */
export function resolveHarness(provider: string): HarnessAdapter | undefined {
  const registration = providerRegistry[provider];
  const legacyHarness = registration?.harnessAdapterCompatibility;
  if (!registration || !legacyHarness) return undefined;

  const controlDriver = (sessionId?: string): ProviderDriver =>
    sessionId &&
      isT3ThreadSessionId(sessionId) &&
      isT3EngineId(registration.driver.provider)
      ? t3ProviderDrivers[registration.driver.provider]
      : registration.driver;
  const controlSession = (
    driver: ProviderDriver,
    handle: HarnessSessionHandle,
  ): HarnessSession => ({
    provider: driver.provider,
    nativeSessionId: handle.sessionId,
    runtime: { kind: "sandbox", id: handle.sandboxId },
    protocolVersion: driver.descriptor.protocol.name,
    capabilities: driver.descriptor.capabilities,
    generation: driver.descriptor.protocol.name === "t3-orchestration"
      ? T3_SESSION_GENERATION
      : 1,
  });

  return {
    provider: registration.driver.provider,
    capabilities(handle) {
      const driver = controlDriver(handle?.sessionId);
      return driver.descriptor.protocol.name === "t3-orchestration"
        ? providerDriverHarnessCapabilities(driver)
        : legacyHarness.capabilities(handle);
    },
    cancel(handle, reason) {
      const driver = controlDriver(handle.sessionId);
      return driver.cancel(controlSession(driver, handle), reason);
    },
    reconcile(handle, checkpoint) {
      const driver = controlDriver(handle.sessionId);
      return driver.reconcile
        ? driver.reconcile({ session: controlSession(driver, handle), checkpoint })
        : legacyHarness.reconcile(handle, checkpoint);
    },
  };
}
