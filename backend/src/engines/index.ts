import { acpAdapter } from "./acp";
import {
  makeOpenCodeServerAdapter,
  opencodeProviderDriver,
} from "./opencode-server";
import { opencodeHarness } from "./opencode-harness";
import {
  makeRuntimeAdapter,
  runtimeAdapterEngineSelected,
  runtimeAdapterSelected,
} from "./runtime-adapter";
import { assertRunProviderCredential } from "./provider-credential-gate";
import { T3_SESSION_GENERATION, t3ProviderDrivers } from "./t3-provider-driver";
import {
  normalizeNegotiatedCapabilities,
  type HarnessSession,
  type ProviderSessionBinding,
} from "@useagent/agent-harness/canonical";
import {
  providerDriverHarnessCapabilities,
  providerDriverUnsupported,
  providerProtocolIdentity,
  unsupportedProviderDriverOperations,
  type HarnessSessionHandle,
  type ProviderDriver,
  type ProviderDriverCapability,
} from "@useagent/agent-harness/control";
import type { EngineAdapter, EngineRunContext, HarnessAdapter } from "./types";
import type { RuntimeEngineId } from "./runtime-orchestration";
import { sessionCapabilities } from "./capabilities";
import { piAdapter } from "./pi-adapter";
import { piHarness, piProviderDriver } from "./pi-provider-driver";
import type { SandboxProviderKind } from "@useagent/sandbox-contract";

// Register the native lifecycle drivers. `mock` is NOT registered here — it
// stays the scripted worker path (worker.ts) and is the default. Every
// user-facing engine retains its own native protocol regardless of whether its
// sandbox comes from Cube, Daytona, or Box. Codex and Claude use their resident
// T3 lifecycle drivers; OpenCode keeps its native server unless its explicit T3
// cutover is selected; Pi keeps its RPC driver. The generic `acp` id remains an
// explicit compatibility lane for future engines. `daytona` / `claude-sdk` are
// legacy aliases so pre-consolidation rows still resolve without changing the
// canonical engine identity.

function makeEngineAdapterCompatibilityDriver(
  provider: string,
  harnessCompatibility?: HarnessAdapter,
  protocol: { readonly name: string; readonly version?: string } = {
    name: "engine-adapter-compatibility",
  },
  sessionGeneration: number | "runtime" = "runtime",
): ProviderDriver {
  const engineCapabilities =
    provider === "acp"
      ? normalizeNegotiatedCapabilities({})
      : sessionCapabilities(provider, { desktop: false, knowledgeTools: false });
  const control = harnessCompatibility?.capabilities();
  const lifecycle = [
    ...(control?.authoritativeHistory ? ["reconcile" as const] : []),
    ...(control?.cancel ? ["cancel" as const] : []),
  ];
  const capabilities = normalizeNegotiatedCapabilities({
    ...engineCapabilities,
    resume: false,
    load: false,
    stop: lifecycle.includes("cancel"),
    reconcile: lifecycle.includes("reconcile"),
    modelSelection: false,
  });
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
      protocol,
      sessionGeneration,
      capabilities,
      lifecycle: { operations: lifecycle, steerInputs: [] },
      model: { selection: "fixed" },
      tools: { mode: "useagent_brokered", approval: "useagent" },
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
}

const acpRegistration: ProviderRegistration = {
  driver: makeEngineAdapterCompatibilityDriver("acp"),
  execution: { kind: "acp_compatibility", adapter: acpAdapter },
};
const claudeRegistration: ProviderRegistration = {
  driver: t3ProviderDrivers.claude,
  execution: {
    kind: "provider",
    run: (ctx, driver) => makeRuntimeAdapter("claude", driver).run(ctx),
  },
};
const codexRegistration: ProviderRegistration = {
  driver: t3ProviderDrivers.codex,
  execution: {
    kind: "provider",
    run: (ctx, driver) => makeRuntimeAdapter("codex", driver).run(ctx),
  },
};
const opencodeRegistration: ProviderRegistration = {
  driver: opencodeProviderDriver,
  execution: {
    kind: "provider",
    run: (ctx, driver) => makeOpenCodeServerAdapter(driver).run(ctx),
  },
  harnessAdapterCompatibility: opencodeHarness,
};
const piRegistration: ProviderRegistration = {
  driver: piProviderDriver,
  execution: {
    kind: "provider",
    run: async (ctx) => piAdapter.run(ctx),
  },
  harnessAdapterCompatibility: piHarness,
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
  pi: piRegistration,
};

function isRuntimeEngineId(provider: string): provider is RuntimeEngineId {
  return provider === "codex" || provider === "claude" || provider === "opencode";
}

export function resolveProviderRegistration(provider: string): ProviderRegistration | undefined {
  return providerRegistry[provider];
}

export function resolveProviderDriver(
  provider: string,
  ctx?: Pick<EngineRunContext, "runId" | "threadId">,
  env: Readonly<Record<string, string | undefined>> = process.env,
  _sandboxKind?: SandboxProviderKind,
): ProviderDriver | undefined {
  const registration = resolveProviderRegistration(provider);
  if (!registration) return undefined;
  const canonicalProvider = registration.driver.provider;
  return ctx && canonicalProvider === "opencode" &&
    runtimeAdapterEngineSelected(canonicalProvider, env) &&
    runtimeAdapterSelected(ctx, env)
    ? t3ProviderDrivers.opencode
    : registration.driver;
}

/** Resolve only when the complete persisted protocol/generation authority
 * matches a current driver. Provider aliases are normalized by registration;
 * a stale or cross-provider binding never reaches a control surface. */
export function resolveProviderDriverForSession(
  provider: string,
  session: Pick<ProviderSessionBinding, "provider" | "protocol" | "generation" | "authEpoch">,
  currentAuthEpoch: string | null,
): ProviderDriver | undefined {
  const registration = resolveProviderRegistration(provider);
  if (
    !registration ||
    session.provider !== registration.driver.provider ||
    session.authEpoch !== currentAuthEpoch
  ) return undefined;
  const candidates: readonly ProviderDriver[] = [
    registration.driver,
    ...(isRuntimeEngineId(registration.driver.provider)
      ? [t3ProviderDrivers[registration.driver.provider]]
      : []),
  ];
  return candidates.find((driver) =>
    providerProtocolIdentity(driver.descriptor.protocol) === session.protocol &&
    typeof driver.descriptor.sessionGeneration === "number" &&
    driver.descriptor.sessionGeneration === session.generation
  );
}

/** Authoritative production turn dispatch. Provider-native resident turns
 * receive their lifecycle driver; explicit adapter registrations retain their
 * own native grammar. ACP is reachable only through the explicit `acp` id. */
export async function runProviderTurn(
  provider: string,
  ctx: EngineRunContext,
): Promise<boolean> {
  const registration = resolveProviderRegistration(provider);
  const selected = resolveProviderDriver(provider, ctx);
  const driver = selected;
  if (!registration || !driver) return false;
  await assertRunProviderCredential(provider, ctx);

  if (driver.descriptor.protocol.name === "t3-orchestration") {
    if (!isRuntimeEngineId(driver.provider)) {
      throw new Error(`Engine driver has unsupported provider '${driver.provider}'`);
    }
    await makeRuntimeAdapter(driver.provider, driver).run(ctx);
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
  if (!registration || (!legacyHarness && !isRuntimeEngineId(registration.driver.provider))) {
    return undefined;
  }

  const controlDriver = (handle?: HarnessSessionHandle): ProviderDriver | null => {
    if (!handle?.protocol || handle.generation === undefined) return registration.driver;
    if (handle.provider !== registration.driver.provider) return null;
    if (handle.authEpoch === undefined || handle.currentAuthEpoch === undefined) return null;
    return resolveProviderDriverForSession(provider, {
      provider: handle.provider,
      protocol: handle.protocol,
      generation: handle.generation,
      authEpoch: handle.authEpoch,
    }, handle.currentAuthEpoch) ?? null;
  };
  const controlSession = (
    driver: ProviderDriver,
    handle: HarnessSessionHandle,
  ): HarnessSession => ({
    provider: driver.provider,
    nativeSessionId: handle.sessionId,
    runtime: { kind: "sandbox", id: handle.sandboxId },
    protocolVersion: handle.protocol ?? providerProtocolIdentity(driver.descriptor.protocol),
    capabilities: driver.descriptor.capabilities,
    generation: handle.generation ?? (
      typeof driver.descriptor.sessionGeneration === "number"
        ? driver.descriptor.sessionGeneration
        : 1
    ),
  });

  return {
    provider: registration.driver.provider,
    capabilities(handle) {
      const driver = controlDriver(handle);
      if (!driver) {
        return {
          resume: false,
          cancel: false,
          streaming: "none",
          authoritativeHistory: false,
          childSessions: false,
          approvals: false,
          questions: false,
          reasoning: false,
          todos: false,
          patches: false,
          usage: false,
        };
      }
      return driver.descriptor.protocol.name === "t3-orchestration" || !legacyHarness
        ? providerDriverHarnessCapabilities(driver)
        : legacyHarness.capabilities(handle);
    },
    cancel(handle, reason) {
      const driver = controlDriver(handle);
      if (!driver) {
        return Promise.resolve(providerDriverUnsupported(
          registration.driver.provider,
          "cancel",
          "provider session protocol or generation is stale",
        ));
      }
      return driver.cancel(controlSession(driver, handle), reason);
    },
    reconcile(handle, checkpoint) {
      const driver = controlDriver(handle);
      if (!driver) {
        return Promise.resolve(providerDriverUnsupported(
          registration.driver.provider,
          "reconcile",
          "provider session protocol or generation is stale",
        ));
      }
      return driver.reconcile
        ? driver.reconcile({ session: controlSession(driver, handle), checkpoint })
        : legacyHarness
          ? legacyHarness.reconcile(handle, checkpoint)
          : Promise.resolve(providerDriverUnsupported(
              registration.driver.provider,
              "reconcile",
              "provider-native adapter does not expose authoritative history",
            ));
    },
  };
}
