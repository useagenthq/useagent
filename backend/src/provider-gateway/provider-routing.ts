import { KIMI_K3_MODEL } from "../runs/model-policy";

/**
 * The literal Fireworks Fast Kimi K3 endpoint currently omits tool support.
 * OpenCode always submits agent tools, so route by measured throughput while
 * requiring every submitted parameter instead. This preserves computer use and
 * lets OpenRouter choose the fastest endpoint that can actually execute the turn.
 */
const KIMI_K3_AGENT_ROUTING = {
  sort: "throughput",
  require_parameters: true,
  allow_fallbacks: true,
} as const;

/** Apply trusted server-owned provider routing after the sandbox request passes
 * model authorization. A sandbox cannot pin an incompatible or untrusted route. */
export function applyOpenRouterProviderRouting(model: string, body: string): string {
  if (model !== KIMI_K3_MODEL || !body) return body;

  const parsed = JSON.parse(body) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, provider: KIMI_K3_AGENT_ROUTING });
}
