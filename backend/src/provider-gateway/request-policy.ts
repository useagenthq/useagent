import type { GatewayRun } from "./run-authorization";

export type OutputLimitField = "max_tokens" | "max_output_tokens" | null;

export type ProviderBodyPolicyResult =
  | { readonly ok: false; readonly error: "invalid_json" | "model_not_allowed" | "output_limit_exceeded" }
  | { readonly ok: true; readonly body: string; readonly requestedOutputTokens: number };

function requestModelMatchesRun(run: GatewayRun, requested: unknown): boolean {
  if (requested === run.model) return true;
  return (run.engine === "opencode" || run.engine === "pi") &&
    run.model.startsWith("openai/") &&
    requested === run.model.slice("openai/".length);
}

/**
 * Validate the paid request against the durable run and add a ceiling when the
 * provider endpoint supports one. The sandbox cannot select a second model or
 * silently remove the output cap.
 */
export function applyProviderBodyPolicy(
  run: GatewayRun,
  rawBody: string,
  outputLimitField: OutputLimitField,
  maxOutputTokens: number,
): ProviderBodyPolicyResult {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "invalid_json" };
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: "invalid_json" };
  }

  if (!requestModelMatchesRun(run, body.model)) {
    return { ok: false, error: "model_not_allowed" };
  }

  let requestedOutputTokens = 0;
  if (outputLimitField) {
    const requested = body[outputLimitField];
    if (requested === undefined) {
      body[outputLimitField] = maxOutputTokens;
    } else if (
      typeof requested !== "number" ||
      !Number.isInteger(requested) ||
      requested < 1 ||
      requested > maxOutputTokens
    ) {
      return { ok: false, error: "output_limit_exceeded" };
    }
    requestedOutputTokens = body[outputLimitField] as number;
  }

  return { ok: true, body: JSON.stringify(body), requestedOutputTokens };
}
