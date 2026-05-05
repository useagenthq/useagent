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

/** Environment for a spawned engine: inherit the parent env but PIN `$PWD` to
 *  the isolated workdir. `Bun.spawn({cwd})` changes the real cwd (getcwd) but
 *  does NOT update `$PWD`; a tool that trusts `$PWD` to find its project root
 *  (OpenCode does) would otherwise resolve back into the parent repo and execute
 *  there — the exact isolation breach we must prevent. */
export function childEnv(workdir: string): Record<string, string> {
  return { ...(process.env as Record<string, string>), PWD: workdir };
}
