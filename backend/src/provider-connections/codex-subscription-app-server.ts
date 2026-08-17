import type { ChildProcessWithoutNullStreams } from "node:child_process";

export async function startCodexSubscriptionAppServer(input: {
  readonly authorize: () => Promise<void>;
  readonly isClosed: () => boolean;
  readonly spawn: () => ChildProcessWithoutNullStreams;
  readonly onSpawn: (process: ChildProcessWithoutNullStreams) => void;
}): Promise<ChildProcessWithoutNullStreams> {
  await input.authorize();
  if (input.isClosed()) throw new Error("relay closed before Codex app-server startup");
  const process = input.spawn();
  input.onSpawn(process);
  return process;
}

export async function suppressCodexSubscriptionStartupRejection(
  promise: Promise<unknown>,
): Promise<void> {
  try {
    await promise;
  } catch {
    // The websocket lifecycle reports authorization failure to its peer.
  }
}

export async function attachCodexSubscriptionAppServer(input: {
  readonly childReady: Promise<ChildProcessWithoutNullStreams>;
  readonly isClosed: () => boolean;
  readonly closeChild: () => void;
  readonly onChildClosed: () => void;
  readonly onLine: (line: string) => void;
  readonly closeSocket: (code: number, reason: string) => void;
}): Promise<void> {
  try {
    const process = await input.childReady;
    if (input.isClosed()) {
      input.closeChild();
      return;
    }
    forwardLines(process.stdout, input.onLine);
    // Codex diagnostics stay on the trusted host. Never forward stderr to the
    // untrusted relay client because it may contain host paths.
    process.stderr.resume();
    process.once("exit", () => {
      input.onChildClosed();
      if (!input.isClosed()) input.closeSocket(1011, "Codex app-server exited");
    });
    process.once("error", () => {
      if (!input.isClosed()) input.closeSocket(1011, "Codex app-server failed");
    });
  } catch {
    input.closeSocket(1008, "provider authorization changed");
  }
}

function forwardLines(stream: NodeJS.ReadableStream, send: (line: string) => void): void {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line) send(line);
  });
}
