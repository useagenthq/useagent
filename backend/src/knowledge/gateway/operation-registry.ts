import {
  ARTIFACT_TOOLS,
  executeArtifactTool,
} from "./artifact-tools";
import {
  AUTOMATION_TOOLS,
  executeAutomationTool,
} from "./automation-tools";
import {
  COMPUTER_USE_TOOLS,
  executeComputerUseTool,
} from "./computer-use-tools";
import { executeGcsTool, GCS_TOOLS } from "./gcs-tools";
import {
  executeLoopLoginTool,
  LOOP_LOGIN_TOOLS,
  loopLoginConfigured,
} from "./loop-login-tools";
import { executeMemoryTool, MEMORY_TOOLS } from "./memory-tools";
import {
  executeRecordingTool,
  RECORDING_TOOLS,
} from "./recording-tools";
import {
  executeRepositoryTool,
  REPOSITORY_TOOLS,
} from "./repository-tools";
import { executeSkillTool, SKILL_TOOLS } from "./skill-tools";
import { executeSlackTool, SLACK_TOOLS } from "./slack-tools";
import type { ToolTokenClaims } from "./token";
import { executeKnowledgeTool, KNOWLEDGE_TOOLS } from "./tools";
import {
  executeWebSearchTool,
  WEB_SEARCH_TOOLS,
} from "./web-search-tool";

export interface GatewayToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
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
  { tools: MEMORY_TOOLS, execute: executeMemoryTool },
  { tools: WEB_SEARCH_TOOLS, execute: executeWebSearchTool },
  { tools: ARTIFACT_TOOLS, execute: executeArtifactTool },
  { tools: RECORDING_TOOLS, execute: executeRecordingTool },
  { tools: COMPUTER_USE_TOOLS, execute: executeComputerUseTool },
  { tools: REPOSITORY_TOOLS, execute: executeRepositoryTool },
  { tools: GCS_TOOLS, execute: executeGcsTool },
  { tools: AUTOMATION_TOOLS, execute: executeAutomationTool },
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

const BASE_OPERATIONS = indexFamilies(BASE_TOOL_FAMILIES);
const LOOP_LOGIN_OPERATIONS = indexFamilies([LOOP_LOGIN_FAMILY]);
const SLACK_OPERATIONS = indexFamilies([SLACK_FAMILY]);

export function baseGatewayToolDescriptors(): readonly GatewayToolDescriptor[] {
  return BASE_TOOL_FAMILIES.flatMap<GatewayToolDescriptor>((family) => [
    ...family.tools,
  ]);
}

export function advertisedGatewayToolDescriptors(options: {
  readonly loopLogin: boolean;
  readonly slack: boolean;
}): readonly GatewayToolDescriptor[] {
  return [
    ...baseGatewayToolDescriptors(),
    ...(options.loopLogin ? LOOP_LOGIN_TOOLS : []),
    ...(options.slack ? SLACK_TOOLS : []),
  ];
}

export type GatewayToolExecution =
  | { readonly matched: false }
  | { readonly matched: true; readonly result: unknown };

export async function executeRegisteredGatewayTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<GatewayToolExecution> {
  const executor =
    BASE_OPERATIONS.get(name) ??
    (loopLoginConfigured() ? LOOP_LOGIN_OPERATIONS.get(name) : undefined) ??
    SLACK_OPERATIONS.get(name);
  if (!executor) return { matched: false };
  return { matched: true, result: await executor(claims, name, args) };
}
