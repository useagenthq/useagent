import { AgentClientError } from "@useagent/agent-client/api";

/** A user-facing CLI failure. `exitCode` is the process code the bin exits with
 *  (2 for a usage error, 1 for an operational/config error). The message is terse
 *  and actionable - it names the missing env or the malformed input exactly. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Where a person makes an API key: the API keys section of Settings on the server the
 *  CLI talks to (the web app and the API share one origin). */
export function apiKeysUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/settings#apikeys`;
}

/** The next step for a request the server refused over its credentials, or null for any
 *  other status. A 401 means the server did not accept the key (mistyped, revoked, or
 *  made on another server). A 403 means the key was accepted but its account may not do
 *  this, so the message never calls the key invalid. */
export function apiKeyFailure(status: number | undefined, baseUrl: string): CliError | null {
  if (status === 401) {
    return new CliError(
      `${baseUrl} did not accept USEAGENT_API_KEY (HTTP 401). If it was revoked, mistyped or made on another server, create a key in Settings, API keys (${apiKeysUrl(baseUrl)}) and export it as USEAGENT_API_KEY`,
    );
  }
  if (status === 403) {
    return new CliError(
      `${baseUrl} accepted USEAGENT_API_KEY but refused the request (HTTP 403). Check that the key's account is still a member of the workspace it was made in`,
    );
  }
  return null;
}

/** Any failure as the CliError the bin prints: a CliError as it is, a refused key with its
 *  next step, and anything else with its own message and exit code 1. */
export function toCliError(error: unknown, baseUrl: string): CliError {
  if (error instanceof CliError) return error;
  const refused = error instanceof AgentClientError ? apiKeyFailure(error.status, baseUrl) : null;
  if (refused) return refused;
  return new CliError(error instanceof Error ? error.message : String(error));
}
