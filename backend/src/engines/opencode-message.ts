interface OpenCodeErrorData {
  readonly message?: unknown;
}

interface OpenCodeError {
  readonly name?: unknown;
  readonly data?: unknown;
}

/** Convert OpenCode's structured assistant error into a safe user-facing failure. */
export function opencodeAssistantError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as OpenCodeError;
  const name = typeof candidate.name === "string" ? candidate.name : "ProviderError";
  const data =
    candidate.data && typeof candidate.data === "object"
      ? (candidate.data as OpenCodeErrorData)
      : null;
  const message = typeof data?.message === "string" ? data.message : "the provider rejected the turn";
  const safeMessage = message
    .replace(/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<capability>")
    .slice(0, 300);
  return `${name}: ${safeMessage}`;
}
