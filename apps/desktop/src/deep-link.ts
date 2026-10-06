const OAUTH_CALLBACK_HASH = /^#token=[A-Za-z0-9_-]+={0,2}$/;

/** Token from a `useagent://auth/callback` URL, or null when the value is not that callback. */
export function oauthCallbackToken(value: string): string | null {
  if (value.length === 0 || value.length > 16_384) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "useagent:" ||
    url.hostname !== "auth" ||
    url.pathname !== "/callback" ||
    url.port ||
    url.search ||
    url.username ||
    url.password ||
    !OAUTH_CALLBACK_HASH.test(url.hash)
  ) {
    return null;
  }
  return url.hash.slice("#token=".length);
}

export function isOAuthCallbackUrl(value: string): boolean {
  return oauthCallbackToken(value) !== null;
}

function argumentText(argument: string): string {
  const trimmed = argument.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === "\"" || quote === "'") && trimmed.endsWith(quote)) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * The `useagent:` URL on a command line, if any.
 * Windows and Linux put it in argv for a cold start and for `second-instance`.
 * macOS delivers the same URL through `open-url`, so a normal macOS argv has no match.
 * The last matching argument wins.
 */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  let found: string | null = null;
  for (const argument of argv) {
    const value = argumentText(argument);
    if (value.length === 0 || value.length > 16_384) continue;
    if (/^useagent:/i.test(value)) found = value;
  }
  return found;
}

/** OAuth callback carried on argv. Other `useagent:` links are left for a later handler. */
export function oauthCallbackFromArgv(argv: readonly string[]): string | null {
  const link = deepLinkFromArgv(argv);
  if (!link || !isOAuthCallbackUrl(link)) return null;
  return link;
}
