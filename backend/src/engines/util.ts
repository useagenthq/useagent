// ---------------------------------------------------------------------------
// Shared adapter helpers. The two CLI adapters (codex, opencode) both consume a
// line-delimited JSON event stream over a child process's stdout — this is that
// plumbing, kept in one place.
// ---------------------------------------------------------------------------

/** Yield complete lines from a byte stream (e.g. a subprocess stdout), flushing
 *  a trailing unterminated line at EOF. */
export async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf;
}

/** Parse a JSON line, returning null on anything unparseable (log noise, blank
 *  lines) rather than throwing mid-stream. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Collapse whitespace and cap a label to a single readable line. */
export function truncate(text: string, max = 80): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Last path segment of a file path (for compact file-step labels). */
export function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Durably record WHERE a run executes BEFORE the engine prepares, boots the agent, runs a
 *  tool, exposes a terminal or serves a preview - so those routes (and cleanup + recovery)
 *  can always resolve the sandbox. FAIL-CLOSED: if the association cannot be persisted we
 *  abort the turn rather than run in a box the control plane cannot see. A sandbox we JUST
 *  provisioned this turn (`reused=false`) is torn down so it is never leaked; a reused
 *  resident thread box is left to the caller's normal lifecycle (never destroyed here). The
 *  thrown error is generic - it never carries the raw persistence error, which can embed a
 *  DB connection string. Shared by the ACP and OpenCode adapters so both obey one rule. */
export async function persistSandboxBeforeExecution(args: {
  runId: string;
  sandboxId: string;
  reused: boolean;
  persist: (runId: string, sandboxId: string) => Promise<void>;
  deleteFreshSandbox: () => Promise<void>;
}): Promise<void> {
  try {
    await args.persist(args.runId, args.sandboxId);
  } catch {
    if (!args.reused) await args.deleteFreshSandbox().catch(() => {});
    throw new Error(
      `aborting run ${args.runId}: could not durably persist its sandbox association (fail-closed)`,
    );
  }
}

/** Environment for a spawned engine: inherit the parent env but PIN `$PWD` to
 *  the isolated workdir. `Bun.spawn({cwd})` changes the real cwd (getcwd) but
 *  does NOT update `$PWD`; a tool that trusts `$PWD` to find its project root
 *  (OpenCode does) would otherwise resolve back into the parent repo and execute
 *  there — the exact isolation breach we must prevent. */
export function childEnv(workdir: string): Record<string, string> {
  return { ...(process.env as Record<string, string>), PWD: workdir };
}
