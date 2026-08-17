import type { EngineId } from "../db/schema";

export const ENGINE_AUTH_MODES = ["provider_gateway", "subscription", "hybrid"] as const;
export type EngineAuthMode = (typeof ENGINE_AUTH_MODES)[number];

const ENGINE_AUTH_MODE_SET: ReadonlySet<string> = new Set(ENGINE_AUTH_MODES);

function authModeKey(engine: EngineId): string {
  return `ENGINE_AUTH_MODE_${engine.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * Resolve the advertised credential path for an engine. Codex keeps its
 * backwards-compatible hybrid default; subscription is intentionally Codex
 * only until another driver has an equally isolated native account runtime.
 * A malformed explicit value returns null so callers fail closed.
 */
export function engineAuthMode(
  engine: EngineId,
  env: Record<string, string | undefined> = process.env,
): EngineAuthMode | null {
  const raw = env[authModeKey(engine)]?.trim().toLowerCase();
  const mode = raw || (engine === "codex" ? "hybrid" : "provider_gateway");
  if (!ENGINE_AUTH_MODE_SET.has(mode)) return null;
  if (engine !== "codex" && mode !== "provider_gateway") return null;
  return mode as EngineAuthMode;
}

export function engineUsesProviderGateway(
  engine: EngineId,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const mode = engineAuthMode(engine, env);
  return mode === "provider_gateway" || mode === "hybrid";
}
