import type { GatewayToolDescriptor } from "./operation-registry";

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

export function executeGatewayMetaTool(
  name: string,
  args: Record<string, unknown>,
  availableTools: readonly GatewayToolDescriptor[],
): unknown | null {
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

  return null;
}
