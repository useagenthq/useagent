import { toolServerDisplayName } from "@useagent/agent-harness/canonical";

/**
 * Human display label for a tool's provider/server id. "skynet-knowledge" is the
 * knowledge+capability gateway's WIRE name (backend SERVER_INFO, engine mcp
 * registration, `mcp__skynet-knowledge__` permission prefixes, retained sandbox
 * TOML) - a coupled identifier we never rename. It is useAgent's own trusted tool
 * surface, so the timeline shows it as "useAgent" while the wire value stays put.
 * Genuine engine providers (opencode/claude/codex/pi) and every other id - or a
 * null provider - pass through unchanged.
 */
export function providerDisplayName(provider: string | null): string | null {
  return provider === null ? null : toolServerDisplayName(provider);
}
