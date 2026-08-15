import { describe, expect, test } from "bun:test";
import {
  daytonaSandboxProvider,
  type DaytonaClientPort,
  type DaytonaSandboxPort,
} from "./daytona-provider";
import { sandboxProviderConformance } from "./provider-conformance.test-support";

interface FakeSandboxOptions {
  id?: string;
  state?: string;
  deleteSandbox?: (timeout?: number, wait?: boolean) => Promise<void>;
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
      createPty: async () => ({
        waitForConnection: async () => {},
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

function fakeClient(sandboxes: readonly DaytonaSandboxPort[]): DaytonaClientPort & {
  createOptions: unknown[];
} {
  const byId = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
  const createOptions: unknown[] = [];
  return {
    createOptions,
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
