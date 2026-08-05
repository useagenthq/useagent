import { acpAdapter } from "./acp";
import {
  sandboxClaudeAdapter,
  sandboxCodexAdapter,
  sandboxOpencodeAdapter,
} from "./sandbox";
import type { EngineAdapter } from "./types";

// Registry of the real engine adapters, keyed by engine id. `mock` is NOT here —
// it stays the scripted worker path (worker.ts) and is the default. Every
// user-facing engine executes in a Daytona sandbox (sandbox.ts); local engine
// execution is gone. `daytona` / `claude-sdk` are legacy aliases so
// pre-consolidation rows (and their thread replies) still resolve.
export const adapters: Record<string, EngineAdapter> = {
  acp: acpAdapter,
  claude: sandboxClaudeAdapter,
  "claude-sdk": sandboxClaudeAdapter,
  codex: sandboxCodexAdapter,
  daytona: sandboxOpencodeAdapter,
  opencode: sandboxOpencodeAdapter,
};
