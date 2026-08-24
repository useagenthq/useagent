// Env resolution + client construction. resolveConfig is pure (env record in, config
// out) so it is unit-testable; clientFromEnv wires it to the fleet client.

import { createFleetClient, DEFAULT_BASE_URL, type FleetClient } from "@useagent/agent-client/fleet";
import { CliError } from "./errors";

export interface CliConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** Read USEAGENT_API_KEY (required) + USEAGENT_BASE_URL (optional, defaulted). Throws a
 *  terse CliError naming the missing variable exactly. */
export function resolveConfig(env: Record<string, string | undefined>): CliConfig {
  const apiKey = env.USEAGENT_API_KEY?.trim();
  if (!apiKey) throw new CliError("USEAGENT_API_KEY is not set", 1);
  const baseUrl = env.USEAGENT_BASE_URL?.trim() || DEFAULT_BASE_URL;
  return { baseUrl, apiKey };
}

export function clientFromEnv(env: Record<string, string | undefined>): FleetClient {
  const config = resolveConfig(env);
  return createFleetClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
}
