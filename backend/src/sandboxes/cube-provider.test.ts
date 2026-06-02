import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Sandbox as E2BSandbox, type SandboxInfo } from "e2b";
import { cubeSandboxProvider } from "./cube-provider";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function sandboxInfo(overrides: Partial<SandboxInfo> = {}): SandboxInfo {
  return {
    cpuCount: 2,
    endAt: new Date(Date.now() + 60_000),
    envdVersion: "0.6.0",
    memoryMB: 8192,
    metadata: { "skynet-run": "run-1" },
    sandboxId: "cube-1",
    startedAt: new Date(),
    state: "running",
    templateId: "template-1",
    ...overrides,
  };
}

function fakeSandbox(options: {
  kill?: (pid: number) => Promise<boolean>;
  list?: () => Promise<Array<{ pid: number; envs: Record<string, string> }>>;
  ptySendInput?: (pid: number, data: Uint8Array) => Promise<void>;
  run?: (command: string, options?: unknown) => Promise<unknown>;
  write?: (path: string, data: string) => Promise<unknown>;
} = {}): E2BSandbox {
  return {
    commands: {
      kill: options.kill ?? (async () => true),
      list: options.list ?? (async () => []),
      run: options.run ?? (async () => ({ exitCode: 0, stderr: "", stdout: "" })),
    },
    files: {
      getInfo: async () => ({ size: 0 }),
      read: async () => new Uint8Array(),
      write: options.write ?? (async () => ({ path: "" })),
    },
    getHost: (port: number) => `${port}-cube-1.sandbox.example.com`,
    pty: {
      create: async () => ({
        disconnect: async () => {},
        kill: async () => true,
        pid: 42,
        sendStdin: async () => {
          throw new Error("CommandHandle.sendStdin must not be used for a PTY");
        },
      }),
      resize: async () => {},
      sendInput: options.ptySendInput ?? (async () => {}),
    },
    sandboxId: "cube-1",
    trafficAccessToken: "traffic-token",
  } as unknown as E2BSandbox;
}

describe("Cube sandbox provider", () => {
  test("maps Skynet create options onto the E2B-compatible Cube API", async () => {
    process.env.CUBE_API_URL = "http://127.0.0.1:3000";
    process.env.CUBE_PROXY_SCHEME = "https";
    process.env.CUBE_SANDBOX_DOMAIN = "sandbox.example.com";
    const sandbox = fakeSandbox();
    const create = spyOn(E2BSandbox, "create").mockResolvedValue(sandbox);
    const getInfo = spyOn(E2BSandbox, "getInfo").mockResolvedValue(sandboxInfo());

    const handle = await cubeSandboxProvider("cube-key").create({
      autoStopInterval: 15,
      envVars: {
        BASH_ENV: "/tmp/skynet.env",
        USEAGENT_PROVIDER_GATEWAY_URL: "http://gateway.internal",
      },
      labels: { "skynet-run": "run-1" },
      snapshot: "agent-template",
    });

    expect(create).toHaveBeenCalledWith(
      "agent-template",
      expect.objectContaining({
        apiKey: "cube-key",
        apiUrl: "http://127.0.0.1:3000",
        envs: { USEAGENT_PROVIDER_GATEWAY_URL: "http://gateway.internal" },
        lifecycle: { autoResume: true, onTimeout: "pause" },
        metadata: { "skynet-run": "run-1" },
        network: { allowPublicTraffic: false },
        secure: true,
        timeoutMs: 900_000,
        validateApiKey: false,
      }),
    );
    expect(getInfo).toHaveBeenCalledWith("cube-1", expect.any(Object));
    expect({ cpu: handle.cpu, id: handle.id, memory: handle.memory, state: handle.state }).toEqual({
      cpu: 2,
      id: "cube-1",
      memory: 8,
      state: "started",
    });

    create.mockRestore();
    getInfo.mockRestore();
  });

  test("allows public Cube traffic only behind an explicitly trusted ingress", async () => {
    process.env.CUBE_PROXY_SCHEME = "https";
    process.env.CUBE_PROXY_TRUSTED_INGRESS = "true";
    const sandbox = fakeSandbox();
    const create = spyOn(E2BSandbox, "create").mockResolvedValue(sandbox);
    const getInfo = spyOn(E2BSandbox, "getInfo").mockResolvedValue(sandboxInfo());

    await cubeSandboxProvider("cube-key").create({ snapshot: "agent-template" });

    expect(create).toHaveBeenCalledWith(
      "agent-template",
      expect.objectContaining({ network: { allowPublicTraffic: true } }),
    );

    create.mockRestore();
    getInfo.mockRestore();
  });

  test("adapts command results and preview credentials", async () => {
    process.env.CUBE_PROXY_SCHEME = "https";
    let commandOptions: unknown;
    const sandbox = fakeSandbox({
      run: async (command, options) => {
        commandOptions = options;
        if (command.startsWith("getent hosts ")) {
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        return { exitCode: 7, stderr: "err", stdout: "out" };
      },
    });
    const create = spyOn(E2BSandbox, "create").mockResolvedValue(sandbox);
    const getInfo = spyOn(E2BSandbox, "getInfo").mockResolvedValue(sandboxInfo());
    const handle = await cubeSandboxProvider("").create({ snapshot: "agent-template" });

    expect(await handle.process.executeCommand("false", "/work", { A: "1" }, 12)).toEqual({
      exitCode: 7,
      result: "outerr",
    });
    expect(commandOptions).toEqual({ cwd: "/work", envs: { A: "1" }, timeoutMs: 12_000 });
    expect(await handle.getPreviewLink(4096)).toEqual({
      token: "traffic-token",
      url: "https://4096-cube-1.sandbox.example.com",
    });

    create.mockRestore();
    getInfo.mockRestore();
  });

  test("preserves non-zero command output when the SDK throws", async () => {
    process.env.CUBE_PROXY_SCHEME = "https";
    const sandbox = fakeSandbox({
      run: async (command) => {
        if (command.startsWith("getent hosts ")) {
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        throw Object.assign(new Error("exit status 7"), {
          exitCode: 7,
          stderr: "diagnostic stderr",
          stdout: "diagnostic stdout",
        });
      },
    });
    const create = spyOn(E2BSandbox, "create").mockResolvedValue(sandbox);
    const getInfo = spyOn(E2BSandbox, "getInfo").mockResolvedValue(sandboxInfo());
    const handle = await cubeSandboxProvider("").create({ snapshot: "agent-template" });

    await expect(handle.process.executeCommand("false")).resolves.toEqual({
      exitCode: 7,
      result: "diagnostic stdoutdiagnostic stderr",
    });

    create.mockRestore();
    getInfo.mockRestore();
  });

  test("sends terminal input through the Cube PTY API", async () => {
    process.env.CUBE_PROXY_SCHEME = "https";
    const writes: Array<{ pid: number; text: string }> = [];
    const sandbox = fakeSandbox({
      ptySendInput: async (pid, data) => {
        writes.push({ pid, text: new TextDecoder().decode(data) });
      },
    });
    const create = spyOn(E2BSandbox, "create").mockResolvedValue(sandbox);
    const getInfo = spyOn(E2BSandbox, "getInfo").mockResolvedValue(sandboxInfo());
    const handle = await cubeSandboxProvider("").create({ snapshot: "agent-template" });

    const pty = await handle.process.createPty({
      id: "terminal-1",
      cols: 80,
      rows: 24,
      onData: () => {},
    });
    await pty.sendInput("printf 'CUBE_PTY_OK\\n'\n");

    expect(writes).toEqual([{ pid: 42, text: "printf 'CUBE_PTY_OK\\n'\n" }]);

    create.mockRestore();
    getInfo.mockRestore();
  });

  test("rejects a non-standard public proxy port the E2B client cannot address", () => {
    process.env.CUBE_PROXY_SCHEME = "https";
    process.env.CUBE_PROXY_PORT_HTTP = "8443";
    expect(() => cubeSandboxProvider("")).toThrow(
      "Cube E2B adapter requires the public proxy on https port 443; got 8443",
    );
  });

  test("does not return a fresh sandbox until its command channel and DNS are ready", async () => {
    process.env.CUBE_PROXY_SCHEME = "https";
    process.env.CUBE_READINESS_RETRY_DELAY_MS = "1";
    let probes = 0;
    const sandbox = fakeSandbox({
      run: async (command) => {
        if (command.startsWith("getent hosts ")) {
          probes += 1;
          return {
            exitCode: probes < 3 ? 2 : 0,
            stderr: "",
            stdout: "",
          };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });
    const create = spyOn(E2BSandbox, "create").mockResolvedValue(sandbox);
    const getInfo = spyOn(E2BSandbox, "getInfo").mockResolvedValue(sandboxInfo());

    const handle = await cubeSandboxProvider("").create({ snapshot: "agent-template" });

    expect(handle.id).toBe("cube-1");
    expect(probes).toBe(3);
    create.mockRestore();
    getInfo.mockRestore();
  });

  test("tags background commands so named sessions survive adapter reconstruction", async () => {
    process.env.CUBE_PROXY_SCHEME = "https";
    const calls: Array<{ command: string; options?: unknown }> = [];
    const writes: Array<{ data: string; path: string }> = [];
    const sandbox = fakeSandbox({
      list: async () => [
        {
          envs: { USEAGENT_COMMAND_ID: "command-1", USEAGENT_SESSION_ID: "resident" },
          pid: 71,
        },
      ],
      run: async (command, options) => {
        calls.push({ command, options });
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      write: async (path, data) => {
        writes.push({ data, path });
        return { path };
      },
    });
    const create = spyOn(E2BSandbox, "create").mockResolvedValue(sandbox);
    const getInfo = spyOn(E2BSandbox, "getInfo").mockResolvedValue(sandboxInfo());
    const handle = await cubeSandboxProvider("").create({ snapshot: "agent-template" });

    const result = await handle.process.executeSessionCommand("resident", {
      command: "exec opencode serve",
      runAsync: true,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.data).toBe("exec opencode serve");
    expect(calls.at(-1)?.command).toMatch(/^nohup setsid sh .* <\/dev\/null >.* 2>&1 &$/);
    expect(calls.at(-1)?.options).toEqual({
      envs: {
        USEAGENT_COMMAND_ID: result.cmdId,
        USEAGENT_SESSION_ID: "resident",
      },
    });
    expect(result.exitCode).toBe(0);
    expect(await handle.process.getSession("resident")).toEqual({
      commands: [{ id: "command-1" }],
    });

    create.mockRestore();
    getInfo.mockRestore();
  });

  test("gets and deletes sessions stamped with exact legacy process markers", async () => {
    process.env.CUBE_PROXY_SCHEME = "https";
    const killed: number[] = [];
    const commands: string[] = [];
    const sandbox = fakeSandbox({
      kill: async (pid) => {
        killed.push(pid);
        return true;
      },
      list: async () => [
        {
          envs: { SKYNET_COMMAND_ID: "legacy-command", SKYNET_SESSION_ID: "legacy-session" },
          pid: 71,
        },
        {
          envs: { SKYNET_COMMAND_ID: "other-command", SKYNET_SESSION_ID: "other-session" },
          pid: 72,
        },
      ],
      run: async (command) => {
        commands.push(command);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });
    const create = spyOn(E2BSandbox, "create").mockResolvedValue(sandbox);
    const getInfo = spyOn(E2BSandbox, "getInfo").mockResolvedValue(sandboxInfo());
    const handle = await cubeSandboxProvider("").create({ snapshot: "agent-template" });

    expect(await handle.process.getSession("legacy-session")).toEqual({
      commands: [{ id: "legacy-command" }],
    });
    await handle.process.deleteSession("legacy-session");

    expect(killed).toEqual([71]);
    expect(commands.at(-1)).toBe("rm -rf /tmp/skynet-cube-sessions/6c65676163792d73657373696f6e");

    create.mockRestore();
    getInfo.mockRestore();
  });

  test("reads per-node placement headroom from the local CubeOps inventory API", async () => {
    process.env.CUBE_PROXY_SCHEME = "https";
    process.env.CUBE_OPS_ACCESS_TOKEN = "ops-token";
    process.env.CUBE_OPS_URL = "http://127.0.0.1:12088/opsapi/v1";
    let page = 0;
    const list = spyOn(E2BSandbox, "list").mockReturnValue({
      get hasNext() { return page === 0; },
      nextItems: async () => {
        page += 1;
        return [sandboxInfo({ state: "running" })];
      },
    } as ReturnType<typeof E2BSandbox.list>);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([{
      nodeID: "node-a",
      healthy: true,
      schedulingDisabled: false,
      allocatable: { cpuMilli: 3_000, memoryMB: 12_000 },
    }]), { status: 200 }));

    await expect(cubeSandboxProvider("").inventory?.()).resolves.toMatchObject({
      activeSandboxes: 1,
      nodes: [{
        id: "node-a",
        ready: true,
        schedulingDisabled: false,
        allocatableCpuMillicores: 3_000,
        allocatableMemoryMib: 12_000,
      }],
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:12088/opsapi/v1/nodes",
      expect.objectContaining({ headers: { Authorization: "Bearer ops-token" } }),
    );
    list.mockRestore();
    fetchSpy.mockRestore();
  });
});
