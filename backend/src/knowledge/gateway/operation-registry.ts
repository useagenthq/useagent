import { ARTIFACT_TOOLS, executeArtifactTool } from "./artifact-tools";
import { AUTOMATION_TOOLS, executeAutomationTool } from "./automation-tools";
import { BLUEPRINT_TOOLS, executeBlueprintTool } from "./blueprint-tools";
import {
  CHILD_SESSION_TOOLS,
  childSessionToolsEnabled,
  executeChildSessionTool,
} from "./child-session-tools";
import { COMPUTER_USE_TOOLS, executeComputerUseTool } from "./computer-use-tools";
import { executeGcsTool, GCS_TOOLS } from "./gcs-tools";
import {
  executeGatewayMetaTool,
  GATEWAY_META_TOOLS,
  gatewayCompactToolListEnabled,
  isGatewayMetaToolName,
} from "./gateway-meta-tools";
import {
  executeKnowledgeManagementTool,
  KNOWLEDGE_MANAGEMENT_TOOLS,
} from "./knowledge-management-tools";
import { executeLoopLoginTool, LOOP_LOGIN_TOOLS, loopLoginConfigured } from "./loop-login-tools";
import { executeMemoryTool, MEMORY_TOOLS } from "./memory-tools";
import { executeRecordingTool, RECORDING_TOOLS } from "./recording-tools";
import { executeRepositoryTool, REPOSITORY_TOOLS } from "./repository-tools";
import { executeSkillTool, SKILL_TOOLS } from "./skill-tools";
import { executeSlackTool, SLACK_TOOLS } from "./slack-tools";
import type { ToolTokenClaims } from "./token";
import { executeKnowledgeTool, KNOWLEDGE_TOOLS } from "./tools";
import { executeWebSearchTool, WEB_SEARCH_TOOLS } from "./web-search-tool";

export interface GatewayToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface GatewayToolListOptions {
  readonly childSessions: boolean;
  readonly loopLogin: boolean;
  readonly slack: boolean;
}

type GatewayToolExecutor = (
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

interface GatewayToolFamily {
  readonly tools: readonly GatewayToolDescriptor[];
  readonly execute: GatewayToolExecutor;
}

const BASE_TOOL_FAMILIES = [
  { tools: KNOWLEDGE_TOOLS, execute: executeKnowledgeTool },
  { tools: KNOWLEDGE_MANAGEMENT_TOOLS, execute: executeKnowledgeManagementTool },
  { tools: MEMORY_TOOLS, execute: executeMemoryTool },
  { tools: WEB_SEARCH_TOOLS, execute: executeWebSearchTool },
  { tools: ARTIFACT_TOOLS, execute: executeArtifactTool },
  { tools: RECORDING_TOOLS, execute: executeRecordingTool },
  { tools: COMPUTER_USE_TOOLS, execute: executeComputerUseTool },
  { tools: REPOSITORY_TOOLS, execute: executeRepositoryTool },
  { tools: GCS_TOOLS, execute: executeGcsTool },
  { tools: AUTOMATION_TOOLS, execute: executeAutomationTool },
  { tools: BLUEPRINT_TOOLS, execute: executeBlueprintTool },
  { tools: CHILD_SESSION_TOOLS, execute: executeChildSessionTool },
  { tools: SKILL_TOOLS, execute: executeSkillTool },
] as const satisfies readonly GatewayToolFamily[];

const LOOP_LOGIN_FAMILY = {
  tools: LOOP_LOGIN_TOOLS,
  execute: executeLoopLoginTool,
} as const satisfies GatewayToolFamily;

const SLACK_FAMILY = {
  tools: SLACK_TOOLS,
  execute: executeSlackTool,
} as const satisfies GatewayToolFamily;

const ALL_TOOL_FAMILIES = [
  ...BASE_TOOL_FAMILIES,
  LOOP_LOGIN_FAMILY,
  SLACK_FAMILY,
] as const satisfies readonly GatewayToolFamily[];

function indexFamilies(
  families: readonly GatewayToolFamily[],
): ReadonlyMap<string, GatewayToolExecutor> {
  const operations = new Map<string, GatewayToolExecutor>();
  for (const family of families) {
    for (const tool of family.tools) {
      if (operations.has(tool.name)) {
        throw new Error(`Duplicate gateway tool name: ${tool.name}`);
      }
      operations.set(tool.name, family.execute);
    }
  }
  return operations;
}

// Build one process-wide index so duplicate names fail during module loading,
// including collisions between always-on and conditional tool families.
const ALL_OPERATIONS = indexFamilies(ALL_TOOL_FAMILIES);
const CHILD_SESSION_TOOL_NAMES: ReadonlySet<string> = new Set(
  CHILD_SESSION_TOOLS.map((tool) => tool.name),
);
const LOOP_LOGIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  LOOP_LOGIN_TOOLS.map((tool) => tool.name),
);

export function baseGatewayToolDescriptors(): readonly GatewayToolDescriptor[] {
  return BASE_TOOL_FAMILIES.flatMap<GatewayToolDescriptor>((family) => [...family.tools]);
}

export function gatewayMetaToolDescriptors(): readonly GatewayToolDescriptor[] {
  return GATEWAY_META_TOOLS;
}

export function advertisedGatewayToolDescriptors(
  options: GatewayToolListOptions,
): readonly GatewayToolDescriptor[] {
  return [
    ...BASE_TOOL_FAMILIES.flatMap<GatewayToolDescriptor>((family) =>
      family.tools === CHILD_SESSION_TOOLS && !options.childSessions ? [] : [...family.tools],
    ),
    ...(options.loopLogin ? LOOP_LOGIN_TOOLS : []),
    ...(options.slack ? SLACK_TOOLS : []),
  ];
}

export function gatewayToolListDescriptors(
  options: GatewayToolListOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly GatewayToolDescriptor[] {
  return gatewayCompactToolListEnabled(env)
    ? GATEWAY_META_TOOLS
    : advertisedGatewayToolDescriptors(options);
}

function availableGatewayToolDescriptors(
  options: GatewayToolListOptions,
): readonly GatewayToolDescriptor[] {
  return [...GATEWAY_META_TOOLS, ...advertisedGatewayToolDescriptors(options)];
}

export type GatewayToolExecution =
  | { readonly matched: false }
  | { readonly matched: true; readonly result: unknown };

export async function executeRegisteredGatewayTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
  options?: GatewayToolListOptions,
): Promise<GatewayToolExecution> {
  const resolvedOptions = options ?? {
    childSessions: await childSessionToolsEnabled(claims),
    loopLogin: loopLoginConfigured(),
    slack: false,
  };
  if (isGatewayMetaToolName(name)) {
    return {
      matched: true,
      result: executeGatewayMetaTool(
        name,
        args,
        availableGatewayToolDescriptors(resolvedOptions),
      ),
    };
  }
  if (CHILD_SESSION_TOOL_NAMES.has(name) && !(await childSessionToolsEnabled(claims))) {
    return {
      matched: true,
      result: {
        content: [
          { type: "text", text: "Child sessions are not enabled for the current live run." },
        ],
        isError: true,
      },
    };
  }
  if (LOOP_LOGIN_TOOL_NAMES.has(name) && !loopLoginConfigured()) {
    return { matched: false };
  }
  const executor = ALL_OPERATIONS.get(name);
  if (!executor) return { matched: false };
  return { matched: true, result: await executor(claims, name, args) };
}

export { gatewayCompactToolListEnabled, isGatewayMetaToolName } from "./gateway-meta-tools";
