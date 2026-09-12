import type { CapabilityCatalog } from "@/lib/capability-catalog";

export type ServerStatus = "connected" | "error";

export interface McpServer {
  id: string;
  name: string;
  initial: string;
  tileClass: string;
  status: ServerStatus;
  summary?: string;
  tools?: string[];
}

export function gatewayServerFromCapabilityCatalog(
  catalog: CapabilityCatalog | null,
  loaded: boolean,
): McpServer {
  const configuredTools = catalog?.tools.declared.filter((tool) => tool.configured) ?? [];
  return {
    id: "useagent-gateway",
    name: "useAgent Gateway",
    initial: "U",
    tileClass: "bg-blue-200 text-blue-700",
    status: catalog?.tools.gatewayConfigured ? "connected" : "error",
    summary: !loaded
      ? "Loading capability catalog"
      : catalog?.tools.gatewayConfigured
        ? `${configuredTools.length} tools configured; live-run availability is resolved per session`
        : "Tool gateway is not configured",
    tools: configuredTools.map((tool) => tool.name),
  };
}
