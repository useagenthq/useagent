import type { NegotiatedCapabilities } from "@useagent/agent-harness/canonical";
import { normalizeNegotiatedCapabilities } from "@useagent/agent-harness/canonical";
import type { EngineId } from "../db/schema";
import { resolveProviderRegistration } from "../engines";
import { sessionCapabilities } from "../engines/capabilities";
import {
  runtimeAdapterEnabled,
  runtimeAdapterEngineSelected,
  runtimeAdapterMode,
} from "../engines/runtime-adapter";
import {
  gatewayToolCatalogDescriptors,
  gatewayToolRequiresApproval,
} from "../knowledge/gateway/operation-registry";
import {
  configuredUserFacingEngines,
  type EngineReadinessReason,
  engineModelReadyForDispatch,
  engineReadiness,
  USER_FACING_ENGINES,
  type UserFacingEngineId,
} from "../runs/engine-readiness";
import { allowedModelsForEngine, defaultModelForEngine } from "../runs/model-policy";
import { t3ProviderDrivers } from "../engines/t3-provider-driver";

export const CAPABILITY_CATALOG_VERSION = 1 as const;
const MAX_TOOLS = 256;
const MAX_ALIASES = 16;

export interface CapabilityCatalogOptions {
  readonly env?: Record<string, string | undefined>;
  readonly gatewayConfigured: boolean;
  readonly slackConfigured: boolean;
  readonly webSearchConfigured?: boolean;
  readonly memoryConfigured?: boolean;
  readonly gcsConfigured?: boolean;
  readonly childSessionsConfigured?: boolean;
  readonly productChildThreadsConfigured?: boolean;
  readonly botsConfigured?: boolean;
}

export interface CapabilityCatalogModel {
  readonly id: string;
  readonly default: boolean;
  readonly dispatchable: boolean;
  readonly degradationReason?: EngineReadinessReason | "model_provider_not_ready";
}

export interface CapabilityCatalogEngine {
  readonly id: UserFacingEngineId;
  readonly configured: boolean;
  readonly ready: boolean;
  readonly degradationReason?: EngineReadinessReason;
  readonly message?: string;
  readonly defaultModel: string;
  readonly models: readonly CapabilityCatalogModel[];
  readonly runtime: {
    readonly kind: "t3" | "native" | "acp_compat" | "direct";
    readonly label: string;
  };
  readonly session: {
    readonly declared: NegotiatedCapabilities;
    readonly currentRun: null;
  };
  readonly execution: {
    readonly declaredFacilities: readonly ("files" | "shell" | "terminal" | "tools")[];
    readonly currentRun: null;
  };
}

function engineRuntime(
  engine: UserFacingEngineId,
  env: Record<string, string | undefined>,
): CapabilityCatalogEngine["runtime"] {
  const label = (() => {
    if (engine === "chat") return "direct model · no sandbox";
    if (engine === "opencode") return "any model · cloud sandbox";
    if (engine === "claude") return "Anthropic agent · cloud sandbox";
    if (engine === "codex") return "OpenAI agent · cloud sandbox";
    return "native Pi harness · cloud sandbox";
  })();
  if (engine === "chat") return { kind: "direct", label };
  if (
    runtimeAdapterEnabled(env) &&
    runtimeAdapterMode(env) === "all" &&
    runtimeAdapterEngineSelected(engine, env)
  ) {
    return { kind: "t3", label };
  }
  if (engine === "opencode") {
    return { kind: "native", label };
  }
  if (engine === "pi") return { kind: "native", label };
  if (env.ENGINE_TRANSPORT === "cli") {
    return { kind: "native", label };
  }
  return { kind: "acp_compat", label };
}

export interface CapabilityCatalogTool {
  readonly name: string;
  readonly category: string;
  readonly aliases: readonly string[];
  readonly declared: true;
  readonly configured: boolean;
  readonly currentRunAvailable: null;
  readonly approval: "required" | "none";
  readonly effect: "artifact_create" | "artifact_update" | "artifact_publish" | "not_declared";
}

export interface CapabilityCatalog {
  readonly version: typeof CAPABILITY_CATALOG_VERSION;
  readonly scope: "pre_run";
  /** Bots surface (preset + home thread) is on for this org. */
  readonly bots: boolean;
  readonly engines: readonly CapabilityCatalogEngine[];
  readonly tools: {
    readonly gatewayConfigured: boolean;
    readonly families: Readonly<Record<string, boolean>>;
    readonly declared: readonly CapabilityCatalogTool[];
  };
  readonly nativeSlashCommands: {
    readonly catalog: "session_runtime";
    readonly currentRun: null;
  };
}

function declaredSessionCapabilities(
  engine: UserFacingEngineId,
  env: Record<string, string | undefined>,
): NegotiatedCapabilities {
  if (engine === "chat") return normalizeNegotiatedCapabilities({ streamingText: true });
  if (
    engine !== "pi" &&
    runtimeAdapterEnabled(env) &&
    runtimeAdapterMode(env) === "all" &&
    runtimeAdapterEngineSelected(engine, env)
  ) {
    return t3ProviderDrivers[engine].descriptor.capabilities;
  }
  return (
    resolveProviderRegistration(engine)?.driver.descriptor.capabilities ??
    sessionCapabilities(engine, { desktop: false, knowledgeTools: false })
  );
}

function buildEngine(
  engine: UserFacingEngineId,
  env: Record<string, string | undefined>,
  gatewayConfigured: boolean,
): CapabilityCatalogEngine {
  const readiness = engineReadiness(engine, env);
  const defaultModel = defaultModelForEngine(engine, env);
  const configured = configuredUserFacingEngines(env).includes(engine);
  const models = allowedModelsForEngine(engine as EngineId, env).map((id) => {
    const dispatchable = engineModelReadyForDispatch(engine as EngineId, id, env);
    return {
      id,
      default: id === defaultModel,
      dispatchable,
      ...(!dispatchable
        ? {
            degradationReason: readiness.ready
              ? ("model_provider_not_ready" as const)
              : readiness.reason,
          }
        : {}),
    };
  });
  return {
    id: engine,
    configured,
    ready: readiness.ready,
    ...(!readiness.ready ? { degradationReason: readiness.reason } : {}),
    ...(readiness.message ? { message: readiness.message } : {}),
    defaultModel,
    models,
    runtime: engineRuntime(engine, env),
    session: {
      declared: normalizeNegotiatedCapabilities(declaredSessionCapabilities(engine, env)),
      currentRun: null,
    },
    execution: {
      declaredFacilities:
        engine === "chat"
          ? []
          : ["files", "shell", "terminal", ...(gatewayConfigured ? ["tools" as const] : [])],
      currentRun: null,
    },
  };
}

/** One bounded, browser-safe pre-run catalog. Current-run truth is deliberately
 * null: runtime bindings, commands, and negotiated availability arrive only on
 * the authenticated session stream. */
export function buildCapabilityCatalog(options: CapabilityCatalogOptions): CapabilityCatalog {
  const env = options.env ?? process.env;
  const familyConfigured: Readonly<Record<string, boolean>> = {
    generic: options.gatewayConfigured,
    web: options.gatewayConfigured && (options.webSearchConfigured ?? false),
    memory: options.gatewayConfigured && (options.memoryConfigured ?? false),
    storage: options.gatewayConfigured && (options.gcsConfigured ?? false),
    slack: options.gatewayConfigured && options.slackConfigured,
    child_sessions: options.gatewayConfigured && (options.childSessionsConfigured ?? true),
  };
  const tools = gatewayToolCatalogDescriptors()
    .slice(0, MAX_TOOLS)
    .map((entry) => ({
      name: entry.descriptor.name,
      category: entry.category,
      aliases: [...(entry.descriptor.aliases ?? [])].slice(0, MAX_ALIASES),
      declared: true as const,
      configured:
        (familyConfigured[entry.category] ?? familyConfigured.generic ?? false) &&
        (entry.descriptor.name !== "child_session_create_many" ||
          options.productChildThreadsConfigured === true ||
          env.PRODUCT_CHILD_THREADS?.trim().toLowerCase() === "on"),
      currentRunAvailable: null,
      approval: gatewayToolRequiresApproval(entry.descriptor.name)
        ? ("required" as const)
        : ("none" as const),
      effect: entry.descriptor.completionEffect?.kind ?? ("not_declared" as const),
    }));
  return {
    version: CAPABILITY_CATALOG_VERSION,
    scope: "pre_run",
    bots: options.botsConfigured === true,
    engines: USER_FACING_ENGINES.map((engine) =>
      buildEngine(engine, env, options.gatewayConfigured),
    ),
    tools: { gatewayConfigured: options.gatewayConfigured, families: familyConfigured, declared: tools },
    nativeSlashCommands: { catalog: "session_runtime", currentRun: null },
  };
}
