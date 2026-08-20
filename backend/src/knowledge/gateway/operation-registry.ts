import {
  APPROVAL_REQUEST_TOOLS,
  executeApprovalRequestTool,
} from "./approval-request-tools";
import { ARTIFACT_TOOLS, executeArtifactTool } from "./artifact-tools";
import {
  AUTOMATION_APPROVAL_REQUIRED_TOOL_NAMES,
  AUTOMATION_TOOLS,
  executeAutomationTool,
} from "./automation-tools";
import { BLUEPRINT_TOOLS, executeBlueprintTool } from "./blueprint-tools";
import {
  CHILD_SESSION_TOOLS,
  childSessionToolsEnabled,
  executeChildSessionTool,
} from "./child-session-tools";
import { COMPUTER_USE_TOOLS, executeComputerUseTool } from "./computer-use-tools";
import { executeGcsTool, GCS_TOOLS } from "./gcs-tools";
import { executeGithubTool, GITHUB_TOOLS } from "./github-tools";
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
import {
  argumentsWithoutApproval,
  consumeGatewayOperationApproval,
} from "./approval-capability";
import { executeLoopLoginTool, LOOP_LOGIN_TOOLS, loopLoginConfigured } from "./loop-login-tools";
import { executeMemoryTool, MEMORY_TOOLS } from "./memory-tools";
import { executeRecordingTool, RECORDING_TOOLS } from "./recording-tools";
import { executeRepositoryTool, REPOSITORY_TOOLS } from "./repository-tools";
import { executeSkillTool, SKILL_TOOLS } from "./skill-tools";
import { executeSlackTool, SLACK_TOOLS } from "./slack-tools";
import type { ToolTokenClaims } from "./token";
import { executeKnowledgeTool, KNOWLEDGE_TOOLS } from "./tools";
import { executeWebSearchTool, WEB_SEARCH_TOOLS } from "./web-search-tool";
import type {
  GatewayToolDescriptor,
  GatewayToolExecutor,
} from "./descriptor";

export type { GatewayToolDescriptor, GatewayToolExecutor } from "./descriptor";

export interface GatewayToolListOptions {
  readonly childSessions: boolean;
  readonly loopLogin: boolean;
  readonly slack: boolean;
}

interface GatewayToolFamily {
  readonly tools: readonly GatewayToolDescriptor[];
  readonly execute: GatewayToolExecutor;
}

const ADDITIONAL_APPROVAL_REQUIRED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "knowledge_draft_publish",
  "knowledge_draft_archive",
]);

/** THE registry of approval-gated operations - discovery, the authenticated
 *  mint route, and the mid-run approval-request lane all read this one set.
 *  Extending it is one entry here (or in a family's own gated-name set). */
export const GATEWAY_APPROVAL_REQUIRED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...AUTOMATION_APPROVAL_REQUIRED_TOOL_NAMES,
  ...ADDITIONAL_APPROVAL_REQUIRED_TOOL_NAMES,
]);

function withApprovalRequirement(tool: GatewayToolDescriptor): GatewayToolDescriptor {
  if (!ADDITIONAL_APPROVAL_REQUIRED_TOOL_NAMES.has(tool.name)) return tool;
  const schema = tool.inputSchema as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
  const properties = { ...(schema.properties ?? {}) };
  delete properties.confirmPublish;
  delete properties.confirmationToken;
  return {
    ...tool,
    description:
      `${tool.description} This operation requires a server-minted one-shot approval capability bound to these exact arguments.`,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...properties,
        approvalCapability: {
          type: "string",
          description:
            "Opaque, short-lived, one-shot capability minted by the authenticated Skynet backend for this exact operation.",
        },
      },
      required: [...new Set([...(schema.required ?? []), "approvalCapability"])],
    },
  };
}

const APPROVED_KNOWLEDGE_MANAGEMENT_TOOLS = KNOWLEDGE_MANAGEMENT_TOOLS.map(
  withApprovalRequirement,
);

const BASE_TOOL_FAMILIES = [
  { tools: KNOWLEDGE_TOOLS, execute: executeKnowledgeTool },
  { tools: APPROVED_KNOWLEDGE_MANAGEMENT_TOOLS, execute: executeKnowledgeManagementTool },
  { tools: MEMORY_TOOLS, execute: executeMemoryTool },
  { tools: WEB_SEARCH_TOOLS, execute: executeWebSearchTool },
  { tools: ARTIFACT_TOOLS, execute: executeArtifactTool },
  { tools: RECORDING_TOOLS, execute: executeRecordingTool },
  { tools: COMPUTER_USE_TOOLS, execute: executeComputerUseTool },
  { tools: REPOSITORY_TOOLS, execute: executeRepositoryTool },
  { tools: GITHUB_TOOLS, execute: executeGithubTool },
  { tools: GCS_TOOLS, execute: executeGcsTool },
  { tools: AUTOMATION_TOOLS, execute: executeAutomationTool },
  { tools: APPROVAL_REQUEST_TOOLS, execute: executeApprovalRequestTool },
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

/** Exact registry metadata, shared by discovery and the authenticated mint route. */
export function gatewayToolRequiresApproval(name: string): boolean {
  return GATEWAY_APPROVAL_REQUIRED_TOOL_NAMES.has(name) && ALL_OPERATIONS.has(name);
}

/** Registered descriptor lookup across every family (conditional included) -
 *  used by approval_request to verify the gated arguments are complete. */
export function advertisedGatewayToolDescriptor(
  name: string,
): GatewayToolDescriptor | null {
  for (const family of ALL_TOOL_FAMILIES) {
    const tool = family.tools.find((candidate) => candidate.name === name);
    if (tool) return tool;
  }
  return null;
}

async function invokeRegisteredOperation(
  executor: GatewayToolExecutor,
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (AUTOMATION_APPROVAL_REQUIRED_TOOL_NAMES.has(name)) {
    return executor(claims, name, args);
  }
  if (
    ADDITIONAL_APPROVAL_REQUIRED_TOOL_NAMES.has(name) &&
    !(await consumeGatewayOperationApproval(claims, name, args))
  ) {
    return {
      content: [
        {
          type: "text",
          text: `A valid server-minted one-shot approval capability is required for ${name}. Call approval_request with this tool name and the exact argument object, have the user approve it in the Skynet session view, poll approval_poll for the approvalCapability, then retry ${name} with it.`,
        },
      ],
      structuredContent: { error: "approval_required" },
      isError: true,
    };
  }
  const operationArgs = argumentsWithoutApproval(args);
  return executor(
    claims,
    name,
    name === "knowledge_draft_publish"
      ? { ...operationArgs, confirmPublish: true }
      : operationArgs,
  );
}

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
    const availableTools = availableGatewayToolDescriptors(resolvedOptions);
    return {
      matched: true,
      result: await executeGatewayMetaTool(
        name,
        args,
        availableTools,
        async (toolName, toolArgs) => {
          const executor = ALL_OPERATIONS.get(toolName);
          if (!executor) {
            return {
              content: [{ type: "text", text: `Unknown gateway tool: ${toolName}` }],
              isError: true,
            };
          }
          return invokeRegisteredOperation(executor, claims, toolName, toolArgs);
        },
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
  return {
    matched: true,
    result: await invokeRegisteredOperation(executor, claims, name, args),
  };
}

export { gatewayCompactToolListEnabled, isGatewayMetaToolName } from "./gateway-meta-tools";
