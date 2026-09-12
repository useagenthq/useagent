import type { EngineId } from "@useagent/agent-client/wire";

export interface CapabilityCatalogModel {
  id: string;
  default: boolean;
  dispatchable: boolean;
  degradationReason?: string;
}

export interface CapabilityCatalogEngine {
  id: EngineId;
  configured: boolean;
  ready: boolean;
  degradationReason?: string;
  message?: string;
  defaultModel: string;
  models: CapabilityCatalogModel[];
  runtime: CapabilityEngineRuntime;
}

export interface CapabilityEngineRuntime {
  kind: "t3" | "native" | "acp_compat" | "direct";
  label: string;
}

export interface CapabilityCatalogTool {
  name: string;
  category: string;
  aliases: string[];
  declared: true;
  configured: boolean;
  currentRunAvailable: null;
  approval: "required" | "none";
  effect: "artifact_create" | "artifact_update" | "artifact_publish" | "not_declared";
}

export interface CapabilityCatalog {
  version: 1;
  scope: "pre_run";
  engines: CapabilityCatalogEngine[];
  tools: {
    gatewayConfigured: boolean;
    declared: CapabilityCatalogTool[];
  };
  nativeSlashCommands: {
    catalog: "session_runtime";
    currentRun: null;
  };
}

const ENGINES: ReadonlySet<string> = new Set(["chat", "opencode", "claude", "codex", "pi"]);
const EFFECTS = new Set(["artifact_create", "artifact_update", "artifact_publish", "not_declared"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseCapabilityCatalog(value: unknown): CapabilityCatalog | null {
  const root = record(value);
  const toolsRoot = record(root?.tools);
  const commands = record(root?.nativeSlashCommands);
  if (
    root?.version !== 1 ||
    root.scope !== "pre_run" ||
    !Array.isArray(root.engines) ||
    !toolsRoot ||
    typeof toolsRoot.gatewayConfigured !== "boolean" ||
    !Array.isArray(toolsRoot.declared) ||
    toolsRoot.declared.length > 256 ||
    commands?.catalog !== "session_runtime" ||
    commands.currentRun !== null
  )
    return null;

  const engines: CapabilityCatalogEngine[] = [];
  for (const item of root.engines) {
    const engine = record(item);
    const runtime = record(engine?.runtime);
    if (
      !engine ||
      typeof engine.id !== "string" ||
      !ENGINES.has(engine.id) ||
      typeof engine.configured !== "boolean" ||
      typeof engine.ready !== "boolean" ||
      typeof engine.defaultModel !== "string" ||
      !Array.isArray(engine.models) ||
      !runtime ||
      (runtime.kind !== "t3" &&
        runtime.kind !== "native" &&
        runtime.kind !== "acp_compat" &&
        runtime.kind !== "direct") ||
      typeof runtime.label !== "string" ||
      runtime.label.length > 120
    )
      return null;
    const models: CapabilityCatalogModel[] = [];
    for (const candidate of engine.models) {
      const model = record(candidate);
      if (
        !model ||
        typeof model.id !== "string" ||
        model.id.length > 200 ||
        typeof model.default !== "boolean" ||
        typeof model.dispatchable !== "boolean"
      )
        return null;
      models.push({
        id: model.id,
        default: model.default,
        dispatchable: model.dispatchable,
        ...(typeof model.degradationReason === "string"
          ? { degradationReason: model.degradationReason }
          : {}),
      });
    }
    engines.push({
      id: engine.id as EngineId,
      configured: engine.configured,
      ready: engine.ready,
      defaultModel: engine.defaultModel,
      models,
      runtime: {
        kind: runtime.kind as CapabilityEngineRuntime["kind"],
        label: runtime.label,
      },
      ...(typeof engine.degradationReason === "string"
        ? { degradationReason: engine.degradationReason }
        : {}),
      ...(typeof engine.message === "string" ? { message: engine.message } : {}),
    });
  }

  const declared: CapabilityCatalogTool[] = [];
  for (const item of toolsRoot.declared) {
    const tool = record(item);
    if (
      !tool ||
      typeof tool.name !== "string" ||
      tool.name.length > 128 ||
      typeof tool.category !== "string" ||
      tool.category.length > 64 ||
      !Array.isArray(tool.aliases) ||
      tool.aliases.length > 16 ||
      !tool.aliases.every((alias) => typeof alias === "string" && alias.length <= 128) ||
      tool.declared !== true ||
      typeof tool.configured !== "boolean" ||
      tool.currentRunAvailable !== null ||
      (tool.approval !== "required" && tool.approval !== "none") ||
      typeof tool.effect !== "string" ||
      !EFFECTS.has(tool.effect)
    )
      return null;
    declared.push({
      name: tool.name,
      category: tool.category,
      aliases: tool.aliases as string[],
      declared: true,
      configured: tool.configured,
      currentRunAvailable: null,
      approval: tool.approval,
      effect: tool.effect as CapabilityCatalogTool["effect"],
    });
  }

  return {
    version: 1,
    scope: "pre_run",
    engines,
    tools: { gatewayConfigured: toolsRoot.gatewayConfigured, declared },
    nativeSlashCommands: { catalog: "session_runtime", currentRun: null },
  };
}

export async function fetchCapabilityCatalog(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
): Promise<CapabilityCatalog | null> {
  try {
    const response = await fetcher("/api/capabilities");
    if (!response.ok) return null;
    return parseCapabilityCatalog(await response.json());
  } catch {
    return null;
  }
}
