import type { IntegrationActionCatalogEntry } from "@skynet/agent-client/integrations";
import {
  executeIntegrationAction,
  listExecutableIntegrationActions,
  type ExecutableIntegrationAction,
} from "../../integrations/service";
import type { GatewayToolDescriptor } from "./descriptor";
import { errorResult, textResult } from "./tool-results";
import type { ToolTokenClaims } from "./token";

const SEARCH_LIMIT = 20;
const MAX_QUERY_CHARS = 160;

interface IntegrationToolService {
  list(scope: { readonly orgId: string; readonly userId: string }): Promise<ExecutableIntegrationAction[]>;
  execute(input: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly actionId: string;
    readonly input: unknown;
    readonly idempotencyKey?: string;
    readonly approvalGranted: boolean;
  }): Promise<unknown>;
}

const productionService: IntegrationToolService = {
  list: listExecutableIntegrationActions,
  execute: executeIntegrationAction,
};

let serviceOverride: IntegrationToolService | null = null;

/** Test-only seam. Production always resolves connections through the tenant-scoped service. */
export function setIntegrationToolServiceForTest(service: IntegrationToolService | null): void {
  serviceOverride = service;
}

function service(): IntegrationToolService {
  return serviceOverride ?? productionService;
}

export const INTEGRATION_TOOLS = [
  {
    name: "integration_actions_search",
    description:
      "Search actions available through the current user's connected workspace integrations. " +
      "Results come from UseAgent's local, policy-pinned catalog; connector credentials and runtime details are never returned.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Words describing the operation, such as `linear update issue` or `gmail send`.",
        },
        provider: {
          type: "string",
          description: "Optional provider id to narrow results, for example `linear` or `gmail`.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "integration_action_execute",
    description:
      "Execute one exact action returned by integration_actions_search against its connected account. " +
      "This operation always requires a server-minted one-shot approval capability bound to the connection, action, and input.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "Connection id returned by integration_actions_search." },
        actionId: { type: "string", description: "Exact action id returned by integration_actions_search." },
        input: {
          type: "object",
          description: "Action arguments matching the inputSchema returned by integration_actions_search.",
          additionalProperties: true,
        },
        idempotencyKey: {
          type: "string",
          description: "Optional stable key for an idempotent action retry. Reuse only for the same exact input.",
        },
      },
      required: ["connectionId", "actionId", "input"],
      additionalProperties: false,
    },
  },
] as const satisfies readonly GatewayToolDescriptor[];

export const INTEGRATION_APPROVAL_REQUIRED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "integration_action_execute",
]);

function checkedString(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function searchable(entry: ExecutableIntegrationAction): string {
  return [
    entry.entry.provider,
    entry.entry.actionId,
    entry.entry.publicName,
    entry.entry.description,
  ].join(" ").toLowerCase();
}

function safeCatalogResult(action: ExecutableIntegrationAction) {
  const entry = action.entry;
  return {
    connectionId: action.connectionId,
    provider: entry.provider,
    actionId: entry.actionId,
    publicName: entry.publicName,
    description: entry.description,
    inputSchema: entry.inputSchema,
    effect: entry.effect,
    approval: entry.approval,
    idempotent: entry.idempotent,
  };
}

function encodedResultSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new Error("integration action returned a non-JSON result");
  }
}

function resultLimit(entry: IntegrationActionCatalogEntry, value: unknown): void {
  if (encodedResultSize(value) > entry.maxResultBytes) {
    throw new Error(`integration action result exceeded ${entry.maxResultBytes} bytes`);
  }
}

export async function executeIntegrationTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
) {
  try {
    if (name === "integration_actions_search") {
      const query = checkedString(args.query, "query");
      if (query.length > MAX_QUERY_CHARS) throw new Error(`query must be at most ${MAX_QUERY_CHARS} characters`);
      const provider = typeof args.provider === "string" ? args.provider.trim().toLowerCase() : "";
      const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
      const available = await service().list({ orgId: claims.orgId, userId: claims.userId });
      const actions = available
        .filter((action) => !provider || action.entry.provider.toLowerCase() === provider)
        .filter((action) => terms.every((term) => searchable(action).includes(term)))
        .slice(0, SEARCH_LIMIT)
        .map(safeCatalogResult);
      return textResult(
        actions.length > 0
          ? `Found ${actions.length} connected integration action${actions.length === 1 ? "" : "s"}.`
          : "No connected integration actions matched that search.",
        { actions },
      );
    }

    if (name === "integration_action_execute") {
      const connectionId = checkedString(args.connectionId, "connectionId");
      const actionId = checkedString(args.actionId, "actionId");
      const input = args.input;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("input must be an object");
      }
      const available = await service().list({ orgId: claims.orgId, userId: claims.userId });
      const selected = available.find(
        (action) => action.connectionId === connectionId && action.entry.actionId === actionId,
      );
      if (!selected) throw new Error("integration action is not available for this connected account");
      const idempotencyKey = typeof args.idempotencyKey === "string" && args.idempotencyKey.trim()
        ? args.idempotencyKey.trim()
        : undefined;
      const result = await service().execute({
        orgId: claims.orgId,
        userId: claims.userId,
        connectionId,
        actionId,
        input,
        approvalGranted: true,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      resultLimit(selected.entry, result);
      return textResult(`Completed ${actionId}.`, { connectionId, actionId, result });
    }

    return errorResult(`Unknown integration tool: ${name}`);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : "integration tool failed");
  }
}
