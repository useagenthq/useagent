import { describe, expect, test } from "bun:test";
import {
  daytonaSandboxProvider,
  type DaytonaClientPort,
  type DaytonaPtyPort,
  type DaytonaSandboxPort,
  type DaytonaSnapshotPort,
} from "./provider";
import { sandboxProviderConformance } from "@useagent/sandbox-contract/conformance";

interface FakeSandboxOptions {
  id?: string;
  state?: string;
  deleteSandbox?: (timeout?: number, wait?: boolean) => Promise<void>;
  pty?: DaytonaPtyPort;
}

function fakeSandbox(options: FakeSandboxOptions = {}): DaytonaSandboxPort {
  return {
    id: options.id ?? "daytona-created",
    cpu: 4,
    memory: 8,
    state: options.state ?? "started",
    labels: { "skynet-run": "run-1" },
    process: {
      executeCommand: async () => ({ exitCode: 0, result: "ok" }),
      createSession: async () => {},
      deleteSession: async () => {},
      getSession: async () => ({ commands: [] }),
      executeSessionCommand: async () => ({ cmdId: "command-1", exitCode: 0 }),
      getSessionCommandLogs: async () => ({ output: "log", stdout: "log", stderr: "" }),
      createPty: async () => options.pty ?? ({
        exitCode: 0,
        error: undefined,
        isConnected: () => false,
        waitForConnection: async () => {},
        wait: async () => ({ exitCode: 0 }),
        sendInput: async () => {},
        resize: async () => {},
        disconnect: async () => {},
        kill: async () => {},
      }),
    },
    fs: {
      getFileDetails: async () => ({ size: 3 }),
      downloadFile: async () => Buffer.from("abc"),
      uploadFile: async () => {},
    },
    computerUse: {
      start: async () => {},
      mouse: {
        click: async () => {},
        move: async () => {},
        drag: async () => {},
        scroll: async () => true,
      },
      keyboard: {
        type: async () => {},
        press: async () => {},
        hotkey: async () => {},
      },
      screenshot: {
        takeFullScreen: async () => ({ screenshot: "image" }),
      },
      display: {
        getInfo: async () => ({ displays: [{ height: 720, isActive: true, width: 1280 }] }),
      },
      recording: {
        start: async () => ({
          fileName: "recording.mp4",
          filePath: "/home/daytona/recording.mp4",
          id: "recording-1",
          startTime: "2026-08-15T00:00:00.000Z",
          status: "recording",
        }),
        stop: async () => ({
          durationSeconds: 2,
          fileName: "recording.mp4",
          filePath: "/home/daytona/recording.mp4",
          id: "recording-1",
          startTime: "2026-08-15T00:00:00.000Z",
          status: "stopped",
        }),
      },
    },
    start: async () => {},
    delete: options.deleteSandbox ?? (async () => {}),
    getPreviewLink: async (port) => ({
      token: "daytona-token",
      url: `https://${port}-daytona-created.example.com`,
    }),
  };
}

/** A snapshot record that walks through the given states on each read (the last one sticks). */
function fakeSnapshotStore(states: Record<string, readonly string[]>): DaytonaClientPort["snapshot"] & {
  reads: string[];
  activations: string[];
} {
  const remaining = new Map(Object.entries(states).map(([name, list]) => [name, [...list]]));
  const reads: string[] = [];
  const activations: string[] = [];
  const current = (name: string): DaytonaSnapshotPort => {
    const list = remaining.get(name);
    if (!list) throw new Error(`Snapshot ${name} not found`);
    const state = list.length > 1 ? list.shift()! : list[0]!;
    return { name, state, errorReason: state === "error" ? "runner lost the image" : null };
  };
  return {
    reads,
    activations,
    async get(name) {
      reads.push(name);
      return current(name);
    },
    async activate(snapshot) {
      activations.push(snapshot.name);
      return current(snapshot.name);
    },
  };
}

function fakeClient(
  sandboxes: readonly DaytonaSandboxPort[],
  snapshot: DaytonaClientPort["snapshot"] = fakeSnapshotStore({}),
): DaytonaClientPort & {
  createOptions: unknown[];
} {
  const byId = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
  const createOptions: unknown[] = [];
  return {
    createOptions,
    snapshot,
    async create(options) {
      createOptions.push(options);
      const created = sandboxes[0];
      if (!created) throw new Error("no fake sandbox configured");
      return created;
    },
    async get(id) {
      const sandbox = byId.get(id);
      if (!sandbox) throw new Error(`missing fake sandbox ${id}`);
      return sandbox;
    },
    async *list() {
      yield* sandboxes;
    },
  };
}

const config = {
  apiKey: "daytona-key",
  apiUrl: "https://daytona.example.com/api",
  target: "us",
};

describe("Daytona snapshot activation", () => {
  const instant = { sleep: async () => {}, activationPollMs: 1 };

  test("an active snapshot is reported without touching activation", async () => {
    const store = fakeSnapshotStore({ "skynet-agent-v17": ["active"] });
    const provider = daytonaSandboxProvider(config, fakeClient([fakeSandbox()], store), instant);
    expect(await provider.ensureTemplate!("skynet-agent-v17")).toEqual({ name: "skynet-agent-v17", state: "active" });
    expect(store.activations).toEqual([]);
  });

  test("an inactive snapshot is activated, the caller sees the wait, and polling ends at active", async () => {
    const store = fakeSnapshotStore({ "skynet-acp-v3": ["inactive", "building", "building", "active"] });
    const provider = daytonaSandboxProvider(config, fakeClient([fakeSandbox()], store), instant);
    let activating = 0;
    const status = await provider.ensureTemplate!("skynet-acp-v3", { onActivating: () => { activating += 1; } });
    expect(status).toEqual({ name: "skynet-acp-v3", state: "active" });
    expect(activating).toBe(1);
    expect(store.activations).toEqual(["skynet-acp-v3"]);
    expect(store.reads.length).toBeGreaterThan(2);
  });

  test("an absent snapshot is reported as absent, never activated", async () => {
    const store = fakeSnapshotStore({});
    const provider = daytonaSandboxProvider(config, fakeClient([fakeSandbox()], store), instant);
    expect(await provider.ensureTemplate!("skynet-agent-v99")).toEqual({ name: "skynet-agent-v99", state: "absent" });
    expect(store.activations).toEqual([]);
  });

  test("a snapshot that never comes back within the bound reports how long it waited", async () => {
    const store = fakeSnapshotStore({ "skynet-agent-v17": ["inactive", "building"] });
    let clock = 0;
    const provider = daytonaSandboxProvider(config, fakeClient([fakeSandbox()], store), {
      ...instant,
      activationTimeoutMs: 10_000,
      now: () => clock,
      sleep: async () => { clock += 4_000; },
    });
    const status = await provider.ensureTemplate!("skynet-agent-v17");
    expect(status.state).toBe("activating");
    expect(status.detail).toMatch(/still building after \d+s/);
  });

  test("a snapshot in an error state surfaces the provider's reason", async () => {
    const store = fakeSnapshotStore({ "skynet-agent-v17": ["error"] });
    const provider = daytonaSandboxProvider(config, fakeClient([fakeSandbox()], store), instant);
    expect(await provider.ensureTemplate!("skynet-agent-v17")).toEqual({
      name: "skynet-agent-v17",
      state: "error",
      detail: "runner lost the image",
    });
  });
});

describe("Daytona sandbox provider", () => {
  sandboxProviderConformance("Daytona", () => {
    const created = fakeSandbox();
    const existing = fakeSandbox({ id: "daytona-existing", state: "stopped" });
    return {
      provider: daytonaSandboxProvider(config, fakeClient([created, existing])),
      createOptions: { snapshot: "snapshot-1" },
      createdId: created.id,
      existingId: existing.id,
      listedIds: [created.id, existing.id],
    };
  });

  test("preserves create options and wraps the SDK sandbox surfaces", async () => {
    const raw = fakeSandbox();
    const client = fakeClient([raw]);
    const provider = daytonaSandboxProvider(config, client);
    const createOptions = {
      autoDeleteInterval: 120,
      autoStopInterval: 30,
      envVars: { A: "1" },
      labels: { "skynet-run": "run-1" },
      snapshot: "snapshot-1",
    };

    const handle = await provider.create(createOptions);

    expect(client.createOptions).toEqual([createOptions]);
    expect(handle).not.toBe(raw);
    expect(handle.process).not.toBe(raw.process);
    expect(handle.fs).not.toBe(raw.fs);
    expect(handle.computerUse).not.toBe(raw.computerUse);
    expect({
      cpu: handle.cpu,
      id: handle.id,
      labels: handle.labels,
      memory: handle.memory,
      state: handle.state,
    }).toEqual({
      cpu: 4,
      id: "daytona-created",
      labels: { "skynet-run": "run-1" },
      memory: 8,
      state: "started",
    });
  });

  test("PTY termination handles late and instant process exit with one memoized wait", async () => {
    const lateExit = Promise.withResolvers<{ exitCode?: number; error?: string }>();
    let waits = 0;
    const late = fakeSandbox({
      pty: {
        exitCode: undefined,
        error: undefined,
        isConnected: () => true,
        waitForConnection: async () => {},
        wait: async () => {
          waits += 1;
          return await lateExit.promise;
        },
        sendInput: async () => {},
        resize: async () => {},
        disconnect: async () => {},
        kill: async () => {},
      },
    });
    const lateHandle = await daytonaSandboxProvider(config, fakeClient([late])).get(late.id);
    const latePty = await lateHandle.process.createPty({
      id: "late",
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    const first = latePty.waitForTermination();
    expect(latePty.waitForTermination()).toBe(first);
    await Bun.sleep(0);
    expect(waits).toBe(1);
    lateExit.resolve({ exitCode: 7 });
    expect(await first).toEqual({ exitCode: 7 });
    expect(waits).toBe(1);

    let instantWaits = 0;
    const instant = fakeSandbox({
      pty: {
        exitCode: 0,
        error: undefined,
        isConnected: () => false,
        waitForConnection: async () => {
          throw new Error("transport already closed");
        },
        wait: async () => {
          instantWaits += 1;
          return { exitCode: 0 };
        },
        sendInput: async () => {},
        resize: async () => {},
        disconnect: async () => {},
        kill: async () => {},
      },
    });
    const instantHandle = await daytonaSandboxProvider(config, fakeClient([instant])).get(instant.id);
    const instantPty = await instantHandle.process.createPty({
      id: "instant",
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    expect(await instantPty.waitForTermination()).toEqual({ exitCode: 0 });
    expect(instantWaits).toBe(0);
  });

  test("PTY termination observes an SDK error that does not close the transport", async () => {
    let error: string | undefined;
    const raw = fakeSandbox({
      pty: {
        exitCode: undefined,
        get error() {
          return error;
        },
        isConnected: () => true,
        waitForConnection: async () => {},
        wait: () => new Promise(() => {}),
        sendInput: async () => {},
        resize: async () => {},
        disconnect: async () => {},
        kill: async () => {},
      },
    });
    const handle = await daytonaSandboxProvider(config, fakeClient([raw])).get(raw.id);
    const pty = await handle.process.createPty({
      id: "error",
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    const termination = pty.waitForTermination();
    await Bun.sleep(0);
    error = "credential-bearing wss://secret.example.test/session/token";

    expect(await termination).toEqual({ error: "Daytona PTY termination failed" });
  });

  test("PTY termination keeps observing late errors after successful and failed kill calls", async () => {
    const run = async (kill: () => Promise<unknown>): Promise<void> => {
      let error: string | undefined;
      const raw = fakeSandbox({
        pty: {
          exitCode: undefined,
          get error() {
            return error;
          },
          isConnected: () => true,
          waitForConnection: async () => {},
          wait: () => new Promise(() => {}),
          sendInput: async () => {},
          resize: async () => {},
          disconnect: async () => {},
          kill,
        },
      });
      const handle = await daytonaSandboxProvider(config, fakeClient([raw])).get(raw.id);
      const pty = await handle.process.createPty({
        id: "kill",
        cols: 80,
        rows: 24,
        onData: () => {},
      });
      const termination = pty.waitForTermination();
      await Bun.sleep(0);

      await pty.kill().catch(() => {});
      error = "late SDK failure";

      expect(await termination).toEqual({ error: "Daytona PTY termination failed" });
    };

    await Promise.all([
      run(async () => {}),
      run(async () => {
        throw new Error("kill failed");
      }),
    ]);
  });

  test("disconnect during connection wait prevents a late termination poll", async () => {
    const connection = Promise.withResolvers<void>();
    let connectionChecks = 0;
    const raw = fakeSandbox({
      pty: {
        exitCode: undefined,
        error: undefined,
        isConnected: () => {
          connectionChecks += 1;
          return true;
        },
        waitForConnection: () => connection.promise,
        wait: () => new Promise(() => {}),
        sendInput: async () => {},
        resize: async () => {},
        disconnect: async () => {},
        kill: async () => {},
      },
    });
    const handle = await daytonaSandboxProvider(config, fakeClient([raw])).get(raw.id);
    const pty = await handle.process.createPty({
      id: "disconnect",
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    const termination = pty.waitForTermination();
    await Bun.sleep(0);

    await pty.disconnect();
    expect(await termination).toEqual({ error: "Daytona PTY disconnected" });
    connection.resolve();
    await Bun.sleep(300);

    expect(connectionChecks).toBe(0);
  });

  test("normalizes lifecycle, process, filesystem, preview auth, and computer use", async () => {
    const calls: string[] = [];
    const raw = fakeSandbox({ state: "stopped" });
    raw.start = async () => {
      calls.push("start");
      raw.state = "started";
    };
    raw.process.executeCommand = async (command, cwd, env, timeout) => {
      calls.push(`execute:${command}:${cwd}:${env?.A}:${timeout}`);
      return { exitCode: 7, result: "outerr" };
    };
    raw.fs.uploadFile = async (file, path, timeout) => {
      calls.push(`upload:${file.toString()}:${path}:${timeout}`);
    };
    raw.computerUse.mouse.click = async (x, y, button, double) => {
      calls.push(`click:${x}:${y}:${button}:${double}`);
    };
    raw.computerUse.start = async () => {
      calls.push("computer-start");
    };
    const handle = await daytonaSandboxProvider(config, fakeClient([raw])).get(raw.id);

    await handle.start();
    expect(await handle.process.executeCommand("false", "/work", { A: "1" }, 12)).toEqual({
      exitCode: 7,
      result: "outerr",
    });
    await handle.fs.uploadFile(Buffer.from("abc"), "/work/file", 9);
    await handle.computerUse?.start();
    await handle.computerUse?.mouse.click(10, 20, "right", true);

    expect(await handle.fs.getFileDetails("/work/file")).toEqual({ size: 3 });
    expect(await handle.fs.downloadFile("/work/file")).toEqual(Buffer.from("abc"));
    expect(await handle.computerUse?.screenshot.takeFullScreen(true)).toEqual({
      screenshot: "image",
      sizeBytes: undefined,
    });
    expect(await handle.computerUse?.display.getInfo()).toEqual({
      displays: [{ height: 720, isActive: true, width: 1280 }],
    });
    expect(await handle.computerUse?.recording.start("recording")).toEqual({
      durationSeconds: undefined,
      fileName: "recording.mp4",
      filePath: "/home/daytona/recording.mp4",
      id: "recording-1",
      startTime: "2026-08-15T00:00:00.000Z",
      status: "recording",
    });
    expect(await handle.getPreviewLink(3000)).toEqual({
      token: "daytona-token",
      headers: { "x-daytona-preview-token": "daytona-token" },
      url: "https://3000-daytona-created.example.com",
    });
    expect(calls).toEqual([
      "start",
      "execute:false:/work:1:12",
      "upload:abc:/work/file:9",
      "computer-start",
      "click:10:20:right:true",
    ]);
  });

  test("waits for Daytona to confirm deletion before resolving", async () => {
    const deletionConfirmation = Promise.withResolvers<void>();
    const deleteCalls: Array<[number | undefined, boolean | undefined]> = [];
    const raw = fakeSandbox({
      deleteSandbox: async (timeout, wait) => {
        deleteCalls.push([timeout, wait]);
        await deletionConfirmation.promise;
      },
    });
    const handle = await daytonaSandboxProvider(config, fakeClient([raw])).get(raw.id);
    let resolved = false;

    const deletion = (async () => {
      await handle.delete();
      resolved = true;
    })();
    await Promise.resolve();

    expect(deleteCalls).toEqual([[undefined, true]]);
    expect(resolved).toBe(false);
    deletionConfirmation.resolve();
    await deletion;
    expect(resolved).toBe(true);
    expect(handle.state).toBe("destroyed");
  });
});
