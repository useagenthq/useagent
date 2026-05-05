import { acpAdapter } from "./acp";
import { acpClaudeAdapter, acpCodexAdapter } from "./acp-server";
import { opencodeServerAdapter } from "./opencode-server";
import { sandboxClaudeAdapter, sandboxCodexAdapter } from "./sandbox";
import type { EngineAdapter } from "./types";

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
