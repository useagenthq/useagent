import { describe, expect, test } from "bun:test";
import { createCodexRemoteEnvironmentBootstrap } from "./codex-remote-environment-bootstrap";

describe("Codex remote environment bootstrap", () => {
  test("registers the run-bound exec server after initialized and before thread traffic", async () => {
    const bootstrap = bootstrapForTest("skynet-environment-add-1");
    const initialize = JSON.stringify({ id: 1, method: "initialize", params: {} });
    const initializeResponse = JSON.stringify({ id: 1, result: { userAgent: "codex/0.147.0" } });
    const initialized = JSON.stringify({ method: "initialized" });

    expect(await bootstrap.acceptClientFrame(initialize)).toEqual([initialize]);
    expect(await bootstrap.acceptServerFrame(initializeResponse)).toEqual([initializeResponse]);
    const initializedFrames = await bootstrap.acceptClientFrame(initialized);
    expect(initializedFrames[0]).toBe(initialized);
    expect(JSON.parse(initializedFrames[1] ?? "")).toEqual({
      id: "skynet-environment-add-1",
      method: "environment/add",
      params: {
        environmentId: "skynet-sandbox-1-run-1",
        execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
        connectTimeoutMs: 15_000,
      },
    });

    const threadStart = JSON.stringify({ id: 2, method: "thread/start", params: {} });
    let threadWasReleased = false;
    const pendingThread = bootstrap.acceptClientFrame(threadStart).then((frames) => {
      threadWasReleased = true;
      return frames;
    });
    await Bun.sleep(5);
    expect(threadWasReleased).toBe(false);

    expect(await bootstrap.acceptServerFrame(
      JSON.stringify({ id: "skynet-environment-add-1", result: {} }),
    )).toEqual([]);
    expect(await pendingThread).toEqual([threadStart]);
  });

  test("rejects queued frames when Codex rejects the remote environment", async () => {
    const bootstrap = bootstrapForTest("skynet-environment-add-2");
    await beginRegistration(bootstrap, 7);
    const pending = bootstrap.acceptClientFrame(JSON.stringify({ method: "thread/start" }));

    expect(bootstrap.acceptServerFrame(JSON.stringify({
      id: "skynet-environment-add-2",
      error: { code: -32_000, message: "exec server unavailable" },
    }))).rejects.toThrow("Codex remote environment registration failed");
    expect(pending).rejects.toThrow("Codex remote environment registration failed");
  });

  test("never exposes the private registration response to the relay client", async () => {
    const bootstrap = bootstrapForTest("skynet-environment-add-3");
    await beginRegistration(bootstrap, 11);

    const privateResponse = JSON.stringify({ id: "skynet-environment-add-3", result: {} });
    expect(await bootstrap.acceptServerFrame(privateResponse)).toEqual([]);
  });

  test("preserves notification order while registration is pending", async () => {
    const bootstrap = bootstrapForTest("skynet-environment-add-4");
    await beginRegistration(bootstrap, 21);
    const first = JSON.stringify({ method: "remoteControl/status/changed", params: {} });
    const second = JSON.stringify({ method: "mcpServer/startupStatus/updated", params: {} });

    expect(await bootstrap.acceptServerFrame(first)).toEqual([]);
    expect(await bootstrap.acceptServerFrame(second)).toEqual([]);
    expect(await bootstrap.acceptServerFrame(
      JSON.stringify({ id: "skynet-environment-add-4", result: {} }),
    )).toEqual([first, second]);
  });

  test("unblocks queued frames when the relay closes", async () => {
    const bootstrap = bootstrapForTest("skynet-environment-add-5");
    await beginRegistration(bootstrap, 31);
    const pending = bootstrap.acceptClientFrame(JSON.stringify({ method: "thread/start" }));

    bootstrap.close();
    expect(pending).rejects.toThrow("Codex remote environment bootstrap closed");
  });

  test("accepts initialized only as a notification", async () => {
    const bootstrap = bootstrapForTest("skynet-environment-add-6");
    await bootstrap.acceptClientFrame(JSON.stringify({ id: 41, method: "initialize" }));
    await bootstrap.acceptServerFrame(JSON.stringify({ id: 41, result: {} }));

    expect(bootstrap.acceptClientFrame(JSON.stringify({
      id: 42,
      method: "initialized",
    }))).rejects.toThrow("initialized notification is invalid");
  });
});

function bootstrapForTest(requestId: string) {
  return createCodexRemoteEnvironmentBootstrap({
    environmentId: "skynet-sandbox-1-run-1",
    execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
    requestId: () => requestId,
  });
}

async function beginRegistration(
  bootstrap: ReturnType<typeof bootstrapForTest>,
  initializeId: number,
): Promise<void> {
  await bootstrap.acceptClientFrame(JSON.stringify({ id: initializeId, method: "initialize" }));
  await bootstrap.acceptServerFrame(JSON.stringify({ id: initializeId, result: {} }));
  await bootstrap.acceptClientFrame(JSON.stringify({ method: "initialized" }));
}
