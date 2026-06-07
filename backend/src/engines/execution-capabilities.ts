import type {
  ExecutionFacilityAccess,
  ExecutionAvailability,
  ExecutionCapabilitySnapshot,
  ExecutionFacility,
} from "@useagent/agent-harness/canonical";
import { gatewayCompactToolListEnabled } from "../knowledge/gateway/gateway-meta-tools";

const COMPUTER_OPERATIONS = ["computer_screenshot", "computer_sequence"] as const;

export interface ExecutionCapabilityFacts {
  readonly runtime: "sandbox" | "managed";
  readonly workspaceRoot?: string;
  readonly gatewayAvailable: boolean;
  readonly desktopAvailability: ExecutionAvailability;
  readonly desktopReasonCode?: string;
  readonly filesAvailable?: boolean;
  readonly shellAvailable?: boolean;
  readonly terminalAvailable?: boolean;
}

function nativeFacility(available: boolean): ExecutionFacility {
  return available
    ? { availability: "ready", access: { kind: "native" } }
    : { availability: "unsupported", access: { kind: "none" } };
}

function gatewayAccess(
  operations: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ExecutionFacilityAccess {
  return gatewayCompactToolListEnabled(env)
    ? {
        kind: "useagent_gateway",
        discovery: "compact",
        search: "gateway_tools_search",
        describe: "gateway_tool_describe",
        call: "gateway_tool_call",
        operations,
      }
    : { kind: "useagent_gateway", discovery: "direct", operations };
}

function gatewayFacility(
  availability: ExecutionAvailability,
  gatewayAvailable: boolean,
  operations: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  reasonCode?: string,
): ExecutionFacility {
  if (!gatewayAvailable) {
    return {
      availability: availability === "ready" ? "ready" : "unsupported",
      access: availability === "ready" ? { kind: "user_surface_only" } : { kind: "none" },
      ...(reasonCode ? { reasonCode } : {}),
    };
  }
  return {
    availability,
    access: gatewayAccess(operations, env),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

/** Build model-facing execution truth from prepared runtime facts. The builder
 * is provider-neutral: adapters supply facts; no harness name changes meaning. */
export function buildExecutionCapabilitySnapshot(
  facts: ExecutionCapabilityFacts,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExecutionCapabilitySnapshot {
  const sandbox = facts.runtime === "sandbox";
  const files = nativeFacility(facts.filesAvailable ?? sandbox);
  const shell = nativeFacility(facts.shellAvailable ?? sandbox);
  const terminal = nativeFacility(facts.terminalAvailable ?? sandbox);
  const tools = gatewayFacility(
    facts.gatewayAvailable ? "ready" : "unsupported",
    facts.gatewayAvailable,
    [],
    env,
  );
  const desktop = gatewayFacility(
    facts.desktopAvailability,
    facts.gatewayAvailable,
    COMPUTER_OPERATIONS,
    env,
    facts.desktopReasonCode,
  );
  const browser = gatewayFacility(
    facts.desktopAvailability,
    facts.gatewayAvailable,
    COMPUTER_OPERATIONS,
    env,
    facts.desktopReasonCode,
  );
  return {
    version: 1,
    runtime: facts.runtime,
    ...(facts.workspaceRoot ? { workspaceRoot: facts.workspaceRoot } : {}),
    facilities: { files, shell, terminal, tools, desktop, browser },
  };
}

export function unsupportedExecutionCapabilitySnapshot(
  runtime: "sandbox" | "managed",
  workspaceRoot?: string,
): ExecutionCapabilitySnapshot {
  return buildExecutionCapabilitySnapshot({
    runtime,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    gatewayAvailable: false,
    desktopAvailability: "unsupported",
    filesAvailable: runtime === "sandbox",
    shellAvailable: runtime === "sandbox",
    terminalAvailable: runtime === "sandbox",
  }, {});
}

export function executionCapabilityPrompt(snapshot: ExecutionCapabilitySnapshot): string {
  return `<execution_capabilities>\n` +
    `This current-turn snapshot is authoritative and supersedes earlier snapshots. ` +
    `Facilities marked ready or on_demand are usable without asking the user. ` +
    `Do not infer that a facility is absent because the harness shell is headless. ` +
    `Before declaring any installed tool or integration unavailable, use the tools facility's ` +
    `advertised discovery route. With direct discovery, inspect the tools already listed by the ` +
    `harness. With compact discovery, call gateway_tools_search, then gateway_tool_describe, then ` +
    `gateway_tool_call. Only report a facility unavailable when it is marked degraded ` +
    `or unsupported, or its listed operation returns a classified failure. This snapshot is ` +
    `context, not authorization; signed gateway policy remains authoritative.\n` +
    `${JSON.stringify(snapshot)}\n` +
    `</execution_capabilities>\n\n`;
}
