// The Shell pane's WebSocket against a stand-in thread sandbox: when the shell
// process ends (the person typed `exit`, the sandbox was deleted or replaced)
// the backend must close the browser socket, or the pane sits on a dead shell
// and never reconnects.
import { afterEach, expect, test } from "bun:test";
import type { SandboxHandle } from "../src/sandboxes/provider";
import { forgetLiveThreadSandbox, rememberLiveThreadSandbox } from "../src/engines/sandbox-runtime";
import { env } from "../src/env";
import server from "../src/index";
import { json, waitFor } from "./helpers";

const servers: Array<{ stop(force?: boolean): void }> = [];
const threads: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const threadId of threads.splice(0)) forgetLiveThreadSandbox(threadId);
});

/** A sandbox whose one PTY ends when the test says so. */
function sandboxWithShell(id: string) {
  const { promise: terminated, resolve: endShell } =
    Promise.withResolvers<{ exitCode?: number; error?: string }>();
  const sandbox = {
    id,
    process: {
      createPty: async () => ({
        waitForConnection: async () => {},
        waitForTermination: () => terminated,
        sendInput: async () => {},
        resize: async () => {},
        disconnect: async () => {},
        kill: async () => {},
      }),
    },
  } as unknown as SandboxHandle;
  return { sandbox, endShell };
}

async function openShell(runId: string) {
  const listening = Bun.serve({ port: 0, fetch: server.fetch, websocket: server.websocket });
  servers.push(listening);
  const socket = new WebSocket(`ws://127.0.0.1:${listening.port}/api/runs/${runId}/terminal`, {
    headers: { origin: new URL(env.FRONTEND_ORIGIN).origin },
  });
  const connected = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  socket.onmessage = (event) => {
    if (String(event.data).includes("connected to sandbox")) connected.resolve();
  };
  socket.onclose = () => {
    connected.reject(new Error("closed before the shell connected"));
    closed.resolve();
  };
  await connected.promise;
  return { socket, closed: closed.promise };
}

async function settledRun(): Promise<{ id: string; threadId: string }> {
  const created = await json<{ id: string }>("/api/runs", { method: "POST", body: { prompt: "shell", engine: "mock" } });
  expect(created.status).toBe(201);
  // Wait for the mock turn to settle so its teardown cannot race the stand-in sandbox.
  return waitFor(async () => {
    const { body } = await json<{ status: string; thread_id: string }>(`/api/runs/${created.body.id}`);
    return body.status === "completed" ? { id: created.body.id, threadId: body.thread_id } : null;
  });
}

test("the socket closes when the shell process ends, so the pane can reconnect", async () => {
  const run = await settledRun();
  const { sandbox, endShell } = sandboxWithShell("sandbox-terminal-exit");
  threads.push(run.threadId);
  rememberLiveThreadSandbox(run.threadId, sandbox);

  const { socket, closed } = await openShell(run.id);
  expect(socket.readyState).toBe(WebSocket.OPEN);

  endShell({ exitCode: 0 });
  const outcome = await Promise.race([
    closed.then(() => "closed"),
    Bun.sleep(5_000).then(() => "still open"),
  ]);
  expect(outcome).toBe("closed");
});
