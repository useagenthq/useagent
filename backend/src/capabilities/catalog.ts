import type { NegotiatedCapabilities } from "@useagent/agent-harness/canonical";
import { normalizeNegotiatedCapabilities } from "@useagent/agent-harness/canonical";
import type { EngineId } from "../db/schema";
import { resolveProviderRegistration } from "../engines";
import { sessionCapabilities } from "../engines/capabilities";
import { t3ProviderDrivers } from "../engines/t3-provider-driver";
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
import type { NativeCodexModelCatalog } from "../provider-connections/codex-model-catalog";
import { engineAuthMode } from "../runs/engine-auth-mode";

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
  readonly codexModelCatalog?: NativeCodexModelCatalog;
}

export interface CapabilityCatalogModel {
  readonly id: string;
  readonly default: boolean;
  readonly dispatchable: boolean;
  readonly policyAllowed: boolean;
  readonly displayName?: string;
  readonly nativeAvailable?: true;
  readonly defaultReasoningEffort?: string;
  readonly supportedReasoningEfforts?: readonly string[];
  readonly degradationReason?: EngineReadinessReason | "model_provider_not_ready" | "model_not_allowed";
}

export interface CapabilityCatalogEngine {
  readonly id: UserFacingEngineId;
  readonly configured: boolean;
  readonly ready: boolean;
  readonly degradationReason?: EngineReadinessReason;
  readonly message?: string;
  readonly defaultModel: string;
  readonly models: readonly CapabilityCatalogModel[];
  readonly modelCatalog?: {
    readonly source: "native" | "policy";
    readonly stale: boolean;
    readonly error?: string;
  };
  readonly runtime: {
    readonly kind: "t3" | "native" | "direct";
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
  if (engine === "codex" || engine === "claude" || engine === "opencode") {
    return { kind: "t3", label };
  }
  return { kind: "native", label };
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
  if (engine === "codex" || engine === "claude" || engine === "opencode") {
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
  codexModelCatalog?: NativeCodexModelCatalog,
): CapabilityCatalogEngine {
  const baseReadiness = engineReadiness(engine, env);
  const subscriptionCatalogUnavailable = engine === "codex" &&
    engineAuthMode("codex", env) === "subscription" &&
    codexModelCatalog?.error !== undefined;
  const readiness = subscriptionCatalogUnavailable
    ? {
        engine: "codex" as const,
        ready: false,
        reason: "provider_unhealthy" as const,
        message: codexModelCatalog?.error === "not_connected"
          ? "Connect a Codex account in Settings, then retry."
          : "Codex could not verify this account's model catalog. Refresh models or reconnect the account.",
      }
    : baseReadiness;
  const defaultModel = defaultModelForEngine(engine, env);
  const configured = configuredUserFacingEngines(env).includes(engine);
  const allowedModelIds = allowedModelsForEngine(engine as EngineId, env);
  const policyModels = new Set(allowedModelIds);
  const nativeModels = engine === "codex"
    ? new Map(codexModelCatalog?.models.map((model) => [model.id, model]) ?? [])
    : new Map();
  const modelIds = engine === "codex"
    ? [...new Set([...allowedModelIds, ...nativeModels.keys()])]
    : allowedModelIds;
  const models = modelIds.map((id) => {
    const policyAllowed = policyModels.has(id);
    const nativeModel = nativeModels.get(id);
    const dispatchable = policyAllowed &&
      readiness.ready &&
      engineModelReadyForDispatch(engine as EngineId, id, env);
    return {
      id,
      default: id === defaultModel,
      dispatchable,
      policyAllowed,
      ...(nativeModel?.displayName ? { displayName: nativeModel.displayName } : {}),
      ...(nativeModel ? { nativeAvailable: true as const } : {}),
      ...(nativeModel?.defaultReasoningEffort
        ? { defaultReasoningEffort: nativeModel.defaultReasoningEffort }
        : {}),
      ...(nativeModel?.supportedReasoningEfforts.length
        ? { supportedReasoningEfforts: nativeModel.supportedReasoningEfforts }
        : {}),
      ...(!dispatchable
        ? {
            degradationReason: !policyAllowed
              ? ("model_not_allowed" as const)
              : readiness.ready
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
    ...(engine === "codex"
      ? {
          modelCatalog: {
            source: codexModelCatalog?.status === "native" ? ("native" as const) : ("policy" as const),
            stale: codexModelCatalog?.stale ?? false,
            ...(codexModelCatalog?.error ? { error: codexModelCatalog.error } : {}),
          },
        }
      : {}),
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
      buildEngine(engine, env, options.gatewayConfigured, options.codexModelCatalog),
    ),
    tools: { gatewayConfigured: options.gatewayConfigured, families: familyConfigured, declared: tools },
    nativeSlashCommands: { catalog: "session_runtime", currentRun: null },
  };
}
