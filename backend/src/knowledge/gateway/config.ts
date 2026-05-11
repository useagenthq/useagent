import {
  assertGatewayCapabilitySecret,
  validateGatewayPublicUrl,
} from "../../security/gateway-boundary";

// ---------------------------------------------------------------------------
// Tool-gateway configuration + gating.
//
// The MCP endpoint is mounted only by the dedicated gateway process and remains
// inert without a valid token. What is CONFIG-GATED is the sandbox
// WIRING: the opencode adapter only injects the knowledge MCP server into a
// sandbox's opencode.json when `GATEWAY_PUBLIC_URL` is set — the dedicated,
// narrow origin the (untrusted, cloud) sandbox reaches. Unset → the whole
// agent-callable path is a no-op and existing runs are byte-for-byte unchanged.
//
// Read per call (like memoryConfig/slackConfig) so a deploy/tunnel can toggle it
// without a rebuild, and tests can flip it at runtime.
// ---------------------------------------------------------------------------

/** Path the knowledge MCP endpoint is mounted at (see gateway-app.ts). Also the path
 *  segment appended to the public base URL when wiring a sandbox. */
export const KNOWLEDGE_MCP_PATH = "/api/mcp/knowledge";

/** Default token lifetime — short-lived by design. A thread's sandbox auto-stops
 *  well within this window; a leaked token expires fast. Overridable for ops. */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // never mint an effectively permanent capability

export interface ToolGatewayConfig {
  /** Public, sandbox-reachable base URL of the dedicated gateway (no trailing slash),
   *  e.g. a tunnel origin in dev or the deployed origin in prod. */
  publicUrl: string;
  /** Full MCP endpoint URL the sandbox connects to. */
  mcpUrl: string;
  /** Minted-token TTL, ms. */
  tokenTtlMs: number;
}

/** Resolve the sandbox-wiring config, or null when adapters must not inject it. */
export function toolGatewayConfig(): ToolGatewayConfig | null {
  const rawPublicUrl = process.env.GATEWAY_PUBLIC_URL
    ?.trim()
    .replace(/\/+$/, "");
  if (!rawPublicUrl) return null;
  const publicUrl = validateGatewayPublicUrl(rawPublicUrl);
  assertGatewayCapabilitySecret("TOOL_GATEWAY_SECRET");
  const ttlRaw = Number(process.env.TOOL_GATEWAY_TOKEN_TTL_MS);
  const tokenTtlMs =
    Number.isFinite(ttlRaw) && ttlRaw > 0 && ttlRaw <= MAX_TTL_MS
      ? ttlRaw
      : DEFAULT_TTL_MS;
  return { publicUrl, mcpUrl: `${publicUrl}${KNOWLEDGE_MCP_PATH}`, tokenTtlMs };
}
