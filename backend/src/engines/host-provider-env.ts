// ---------------------------------------------------------------------------
// The ONE producer of the host provider credentials injected into a sandbox
// (D6 / BUG-002 / #121). Every engine adapter (opencode-server, sandbox CLI
// fallback, acp-server) routes through this so there is a single, minimal,
// auditable rule for which host key reaches an untrusted customer sandbox.
//
// SECURITY - UNRESOLVED (#121): injecting the HOST operator's provider key into
// a customer sandbox is a REAL, open credential-exposure risk - the agent (or a
// malicious repo it runs) can read the key from its own environment and
// exfiltrate it / burn the operator's account. This is NOT resolved here; the
// SaaS-safe fix is the trusted provider gateway/broker (#121) that keeps host
// keys OUT of the sandbox entirely. Until it lands we do the one honest thing we
// can: inject the SMALLEST possible surface - exactly the single key the run's
// engine+model actually reads, never the full provider set - and let
// secret-audit-live.ts FAIL while any host key is still present.
// ---------------------------------------------------------------------------

/** Options for {@link hostProviderEnv}. */
export interface HostProviderEnvOpts {
  /** Env to read the raw keys from (injectable for tests). Defaults to process.env. */
  readonly env?: Record<string, string | undefined>;
  /** Whether the DEV-ONLY host-key escape hatch is open (verified-dev yolo). For
   *  the ACP/CLI claude+codex engines the host key is injected ONLY when true;
   *  production (false) injects nothing and relies on per-tenant org secrets. */
  readonly allowHostKeys?: boolean;
}

/**
 * The minimal host provider env for one run's engine+model. Returns only the
 * single key that engine+model actually reads (or none):
 *   - opencode/daytona: opencode routes a slug like "anthropic/claude-…" via
 *     OpenRouter and a bare "claude-…" via the direct Anthropic provider (see
 *     opencode-server.ts modelBody), reading ONLY the matching key - so inject
 *     ONLY that one. opencode is the resident DEFAULT engine with no org-secret
 *     path into its own serve process yet, so this host key is injected
 *     unconditionally (the unresolved #121 risk, minimized to a single key).
 *   - claude / claude-sdk: reads ANTHROPIC_API_KEY. DEV-ONLY (allowHostKeys);
 *     prod uses the org secret / trusted gateway (#121).
 *   - codex: authenticates from OPENAI_API_KEY (`codex login --with-api-key`).
 *     DEV-ONLY, same gate.
 * Never injects a key an engine does not read (no OpenRouter key into a claude
 * sandbox, no OpenAI key into a claude sandbox, etc.). Pure.
 */
export function hostProviderEnv(
  engine: string,
  model: string | undefined,
  opts: HostProviderEnvOpts = {},
): Record<string, string> {
  const env = opts.env ?? process.env;
  const out: Record<string, string> = {};
  const put = (name: string) => {
    const v = env[name];
    if (typeof v === "string" && v.length > 0) out[name] = v;
  };
  switch (engine) {
    case "opencode":
    case "daytona":
      if ((model ?? "").includes("/")) put("OPENROUTER_API_KEY");
      else put("ANTHROPIC_API_KEY");
      break;
    case "claude":
    case "claude-sdk":
      if (opts.allowHostKeys) put("ANTHROPIC_API_KEY");
      break;
    case "codex":
      if (opts.allowHostKeys) put("OPENAI_API_KEY");
      break;
  }
  return out;
}
