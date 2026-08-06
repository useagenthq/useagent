// ---------------------------------------------------------------------------
// Tool-gateway configuration + gating.
//
// The MCP endpoint itself is always mounted (it is token-gated and inert without
// a valid token, so it is safe to expose). What is CONFIG-GATED is the sandbox
// WIRING: the opencode adapter only injects the knowledge MCP server into a
// sandbox's opencode.json when `TOOL_GATEWAY_PUBLIC_URL` is set — the base URL
// the (untrusted, cloud) sandbox uses to reach THIS backend. Unset → the whole
// agent-callable path is a no-op and existing runs are byte-for-byte unchanged.
//
// Read per call (like memoryConfig/slackConfig) so a deploy/tunnel can toggle it
// without a rebuild, and tests can flip it at runtime.
// ---------------------------------------------------------------------------

/** Path the knowledge MCP endpoint is mounted at (see index.ts). Also the path
 *  segment appended to the public base URL when wiring a sandbox. */
export const KNOWLEDGE_MCP_PATH = "/api/mcp/knowledge";

/** Default token lifetime — short-lived by design. A thread's sandbox auto-stops
 *  well within this window; a leaked token expires fast. Overridable for ops. */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export interface ToolGatewayConfig {
  /** Public, sandbox-reachable base URL of THIS backend (no trailing slash),
   *  e.g. a tunnel origin in dev or the deployed origin in prod. */
  publicUrl: string;
  /** Full MCP endpoint URL the sandbox connects to. */
  mcpUrl: string;
  /** Minted-token TTL, ms. */
  tokenTtlMs: number;
}

/** Resolve the sandbox-wiring config, or null when the gateway is not wired for
 *  sandboxes (endpoint stays mounted; adapters simply don't inject it). */
export function toolGatewayConfig(): ToolGatewayConfig | null {
  const publicUrl = process.env.TOOL_GATEWAY_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!publicUrl) return null;
  const ttlRaw = Number(process.env.TOOL_GATEWAY_TOKEN_TTL_MS);
  const tokenTtlMs = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_TTL_MS;
  return { publicUrl, mcpUrl: `${publicUrl}${KNOWLEDGE_MCP_PATH}`, tokenTtlMs };
}
