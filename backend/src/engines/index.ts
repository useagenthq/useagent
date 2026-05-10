import { acpAdapter } from "./acp";
import { claudeHarness, codexHarness } from "./acp-harness";
import { acpClaudeAdapter, acpCodexAdapter } from "./acp-server";
import { opencodeHarness, opencodeServerAdapter } from "./opencode-server";
import { sandboxClaudeAdapter, sandboxCodexAdapter } from "./sandbox";
import type { EngineAdapter, HarnessAdapter } from "./types";

// Registry of the real engine adapters, keyed by engine id. `mock` is NOT here —
// it stays the scripted worker path (worker.ts) and is the default. Every
// user-facing engine runs RESIDENT inside a per-thread Daytona sandbox:
// opencode via its own `opencode serve` (opencode-server.ts), claude/codex via
// persistent ACP agents behind the in-sandbox relay (acp-server.ts). Set
// ENGINE_TRANSPORT=cli to fall back to the per-turn CLI poll-tail runners
// (sandbox.ts) if the resident transport misbehaves. `daytona` / `claude-sdk`
// are legacy aliases so pre-consolidation rows (and their replies) still resolve.
const cliFallback = process.env.ENGINE_TRANSPORT === "cli";
const claude = cliFallback ? sandboxClaudeAdapter : acpClaudeAdapter;
const codex = cliFallback ? sandboxCodexAdapter : acpCodexAdapter;

export const adapters: Record<string, EngineAdapter> = {
  acp: acpAdapter,
  claude,
  "claude-sdk": claude,
  codex,
  daytona: opencodeServerAdapter,
  opencode: opencodeServerAdapter,
};

// The typed HarnessAdapter control seam (capabilities / cancel / reconcile),
// keyed by the same engine ids as `adapters`. SEPARATE from EngineAdapter.run:
// this is the provider-neutral control/observability surface the product layer
// (recovery, Stop) resolves by provider instead of importing a concrete harness.
// OpenCode implements real behavior; the ACP engines report honest capabilities
// and typed `unsupported_capability` for control ops not yet wired (see acp-harness).
export const harnessAdapters: Record<string, HarnessAdapter> = {
  claude: claudeHarness,
  "claude-sdk": claudeHarness,
  codex: codexHarness,
  daytona: opencodeHarness,
  opencode: opencodeHarness,
};

/** Resolve the control adapter for a provider/engine id, or undefined if none is
 *  registered (e.g. the legacy generic `acp` or `mock`). */
export function resolveHarness(provider: string): HarnessAdapter | undefined {
  return harnessAdapters[provider];
}
