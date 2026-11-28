// Env resolution + client construction. resolveConfig is pure (env record in, config
// out) so it is unit-testable; clientFromEnv wires it to the fleet client.

import { createFleetClient, DEFAULT_BASE_URL, type FleetClient } from "@useagent/agent-client/fleet";
import { apiKeysUrl, CliError } from "./errors";

export interface CliConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** USEAGENT_BASE_URL (optional), defaulted to the hosted origin. */
export function resolveBaseUrl(env: Record<string, string | undefined>): string {
  return env.USEAGENT_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

/** Read USEAGENT_API_KEY (required) + USEAGENT_BASE_URL (optional, defaulted). Throws a
 *  terse CliError naming the missing variable exactly, and where to make a key. */
export function resolveConfig(env: Record<string, string | undefined>): CliConfig {
  const baseUrl = resolveBaseUrl(env);
  const apiKey = env.USEAGENT_API_KEY?.trim();
  if (!apiKey) {
    throw new CliError(
      `USEAGENT_API_KEY is not set. Create a key in Settings, API keys (${apiKeysUrl(baseUrl)}), then export USEAGENT_API_KEY=<key>`,
      1,
    );
  }
  return { baseUrl, apiKey };
}

export function clientFromEnv(env: Record<string, string | undefined>): FleetClient {
  const config = resolveConfig(env);
  return createFleetClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
}
