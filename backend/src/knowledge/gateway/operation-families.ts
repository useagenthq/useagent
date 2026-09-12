/**
 * The integration gateway's tool families: every tool module the gateway can
 * execute, grouped by category, plus the process-wide name and alias indexes
 * built from them (duplicates fail at module load). Approval-gated operations
 * are marked here too, so discovery, the mint route and the mid-run approval
 * lane read one set. The operation registry renders catalogs from these
 * families and executes through the indexes; nothing in this module performs an
 * operation.
 */
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
  BOT_HANDOFF_TOOL,
  CHILD_SESSION_TOOLS,
  executeChildSessionTool,
} from "./child-session-tools";
import { CONTEXT_TOOLS, executeContextTool } from "./context-tools";
import { COMPUTER_USE_TOOLS, executeComputerUseTool } from "./computer-use-tools";
import type { GatewayToolDescriptor, GatewayToolExecutor } from "./descriptor";
import { executeGcsTool, GCS_TOOLS } from "./gcs-tools";
import { executeGithubTool, GITHUB_TOOLS } from "./github-tools";
import {
  executeIntegrationTool,
  INTEGRATION_APPROVAL_REQUIRED_TOOL_NAMES,
  INTEGRATION_TOOLS,
} from "./integration-tools";
import {
  executeKnowledgeManagementTool,
  KNOWLEDGE_MANAGEMENT_TOOLS,
} from "./knowledge-management-tools";
import { executeMemoryTool, MEMORY_TOOLS } from "./memory-tools";
import { executeRecordingTool, RECORDING_TOOLS } from "./recording-tools";
import { executeRepositoryTool, REPOSITORY_TOOLS } from "./repository-tools";
import { executeResourceTool, RESOURCE_TOOLS } from "./resource-tools";
import { executeSkillTool, SKILL_TOOLS } from "./skill-tools";
import { executeSlackTool, SLACK_TOOLS } from "./slack-tools";
import { executeTaskTool, TASK_TOOLS } from "./task-tools";
import { executeKnowledgeTool, KNOWLEDGE_TOOLS } from "./tools";
import { executeWebSearchTool, WEB_SEARCH_TOOLS } from "./web-search-tool";

export interface GatewayToolFamily {
  readonly category: string;
  readonly tools: readonly GatewayToolDescriptor[];
  readonly execute: GatewayToolExecutor;
}

export const ADDITIONAL_APPROVAL_REQUIRED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...INTEGRATION_APPROVAL_REQUIRED_TOOL_NAMES,
  "knowledge_draft_publish",
  "knowledge_draft_archive",
  "github_pull_request_publish",
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
            "Opaque, short-lived, one-shot capability minted by the authenticated useAgent backend for this exact operation.",
        },
      },
      required: [...new Set([...(schema.required ?? []), "approvalCapability"])],
    },
  };
}

const APPROVED_KNOWLEDGE_MANAGEMENT_TOOLS = KNOWLEDGE_MANAGEMENT_TOOLS.map(
  withApprovalRequirement,
);
const APPROVED_INTEGRATION_TOOLS = INTEGRATION_TOOLS.map(withApprovalRequirement);
const APPROVED_GITHUB_TOOLS = GITHUB_TOOLS.map(withApprovalRequirement);

export const BASE_TOOL_FAMILIES = [
  { category: "knowledge", tools: KNOWLEDGE_TOOLS, execute: executeKnowledgeTool },
  { category: "context", tools: CONTEXT_TOOLS, execute: executeContextTool },
  { category: "knowledge", tools: APPROVED_KNOWLEDGE_MANAGEMENT_TOOLS, execute: executeKnowledgeManagementTool },
  { category: "memory", tools: MEMORY_TOOLS, execute: executeMemoryTool },
  { category: "integrations", tools: APPROVED_INTEGRATION_TOOLS, execute: executeIntegrationTool },
  { category: "web", tools: WEB_SEARCH_TOOLS, execute: executeWebSearchTool },
  { category: "artifacts", tools: ARTIFACT_TOOLS, execute: executeArtifactTool },
  { category: "recording", tools: RECORDING_TOOLS, execute: executeRecordingTool },
  { category: "computer", tools: COMPUTER_USE_TOOLS, execute: executeComputerUseTool },
  { category: "resources", tools: RESOURCE_TOOLS, execute: executeResourceTool },
  { category: "repositories", tools: REPOSITORY_TOOLS, execute: executeRepositoryTool },
  { category: "github", tools: APPROVED_GITHUB_TOOLS, execute: executeGithubTool },
  { category: "storage", tools: GCS_TOOLS, execute: executeGcsTool },
  { category: "automations", tools: AUTOMATION_TOOLS, execute: executeAutomationTool },
  { category: "approvals", tools: APPROVAL_REQUEST_TOOLS, execute: executeApprovalRequestTool },
  { category: "blueprints", tools: BLUEPRINT_TOOLS, execute: executeBlueprintTool },
  // The registry must resolve every tool the family can execute; which of them a
  // caller sees is decided per org in advertisedChildSessionTools.
  { category: "child_sessions", tools: [...CHILD_SESSION_TOOLS, BOT_HANDOFF_TOOL], execute: executeChildSessionTool },
  { category: "skills", tools: SKILL_TOOLS, execute: executeSkillTool },
  { category: "tasks", tools: TASK_TOOLS, execute: executeTaskTool },
] as const satisfies readonly GatewayToolFamily[];
export const SLACK_FAMILY = {
  category: "slack",
  tools: SLACK_TOOLS,
  execute: executeSlackTool,
} as const satisfies GatewayToolFamily;
export const ALL_TOOL_FAMILIES = [
  ...BASE_TOOL_FAMILIES,
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

function indexAliases(
  families: readonly GatewayToolFamily[],
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  const canonicalNames = new Set(
    families.flatMap((family) => family.tools.map((tool) => tool.name)),
  );
  for (const family of families) {
    for (const tool of family.tools) {
      for (const alias of tool.aliases ?? []) {
        if (canonicalNames.has(alias) || aliases.has(alias)) {
          throw new Error(`Duplicate gateway tool alias: ${alias}`);
        }
        aliases.set(alias, tool.name);
      }
    }
  }
  return aliases;
}

// Build one process-wide index so duplicate names fail during module loading,
// including collisions between always-on and conditional tool families.
export const ALL_OPERATIONS = indexFamilies(ALL_TOOL_FAMILIES);
export const TOOL_ALIASES = indexAliases(ALL_TOOL_FAMILIES);
export const CHILD_SESSION_TOOL_NAMES: ReadonlySet<string> = new Set(
  [...CHILD_SESSION_TOOLS, BOT_HANDOFF_TOOL].map((tool) => tool.name),
);
