import type { GatewayToolDescriptor } from "./operation-registry";
import { errorResult } from "./tool-results";

export const GATEWAY_META_TOOLS = [
  {
    name: "gateway_tools_search",
    description:
      "Search the signed Skynet gateway's available tools by task, capability, or exact name. Use this when compact tool discovery is enabled or when you need to find a tool without carrying every schema in context.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Capability search query, for example memory, automation, computer, repository, or exact tool name.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum matches to return (default 8, max 20).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "gateway_tool_describe",
    description:
      "Return the full authoritative JSON schema for one signed Skynet gateway tool by exact name. Call this before using a tool discovered through gateway_tools_search.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact tool name returned by gateway_tools_search." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "gateway_tool_call",
    description:
      "Invoke one exact signed Skynet gateway tool discovered through gateway_tools_search and gateway_tool_describe. Use this bridge when compact tool discovery is enabled; the target must be available to the current live run.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Exact non-meta tool name returned by gateway_tools_search.",
        },
        arguments: {
          type: "object",
          description: "Arguments matching the schema returned by gateway_tool_describe.",
          additionalProperties: true,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
] as const satisfies readonly GatewayToolDescriptor[];

const GATEWAY_META_TOOL_NAMES: ReadonlySet<string> = new Set(
  GATEWAY_META_TOOLS.map((tool) => tool.name),
);

export function isGatewayMetaToolName(name: string): boolean {
  return GATEWAY_META_TOOL_NAMES.has(name);
}

export function gatewayCompactToolListEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env.GATEWAY_COMPACT_TOOLS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function compactText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function boundedSearchLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(20, Math.max(1, value))
    : 8;
}

function descriptorSearchText(tool: GatewayToolDescriptor): string {
  return `${tool.name} ${tool.description}`.toLowerCase();
}

type GatewayToolInvoker = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export async function executeGatewayMetaTool(
  name: string,
  args: Record<string, unknown>,
  availableTools: readonly GatewayToolDescriptor[],
  invoke?: GatewayToolInvoker,
): Promise<unknown | null> {
  if (name === "gateway_tools_search") {
    const query = compactText(args.query);
    if (!query) {
      return {
        content: [{ type: "text", text: "gateway_tools_search requires a non-empty `query`." }],
        isError: true,
      };
    }
    const terms = query.split(/\s+/).filter(Boolean);
    const matches = availableTools
      .filter((tool) => terms.every((term) => descriptorSearchText(tool).includes(term)))
      .slice(0, boundedSearchLimit(args.limit))
      .map((tool) => ({ name: tool.name, description: tool.description }));
    return {
      content: [
        {
          type: "text",
          text:
            matches.length === 0
              ? `No gateway tools matched "${query}".`
              : matches.map((tool) => `${tool.name}: ${tool.description}`).join("\n"),
        },
      ],
      structuredContent: { tools: matches },
    };
  }

  if (name === "gateway_tool_describe") {
    const toolName = typeof args.name === "string" ? args.name.trim() : "";
    const tool = availableTools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      return {
        content: [
          {
            type: "text",
            text: `No gateway tool named ${toolName || "(empty)"} is available to this run.`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(tool, null, 2) }],
      structuredContent: { tool },
    };
  }

  if (name === "gateway_tool_call") {
    const toolName = typeof args.name === "string" ? args.name.trim() : "";
    if (!toolName) return errorResult("gateway_tool_call requires an exact `name`.");
    if (isGatewayMetaToolName(toolName)) {
      return errorResult("gateway_tool_call cannot invoke gateway meta-tools.");
    }
    if (!availableTools.some((tool) => tool.name === toolName) || !invoke) {
      return errorResult(`Gateway tool ${toolName} is not available to this run.`);
    }
    const toolArguments = args.arguments ?? {};
    if (
      typeof toolArguments !== "object" ||
      toolArguments === null ||
      Array.isArray(toolArguments)
    ) {
      return errorResult("gateway_tool_call `arguments` must be an object.");
    }
    return invoke(toolName, toolArguments as Record<string, unknown>);
  }

  return null;
}
