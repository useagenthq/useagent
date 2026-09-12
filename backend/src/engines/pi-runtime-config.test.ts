import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPiRuntimeInstallCommand,
  ensurePiRuntimeInstalled,
  preparePiRuntime,
  piApiForProvider,
  piModelSelection,
  PI_BRIDGE_GENERATION,
  PI_BUN_VERSION,
  PI_CODING_AGENT_UPSTREAM_SHA,
  PI_CODING_AGENT_VERSION,
  PI_RUNTIME_LOCK_SHA256,
} from "./pi-runtime-config";
import {
  providerGatewaySandboxIsCurrent,
  SANDBOX_GENERATION,
  SANDBOX_GENERATION_LABEL,
} from "../provider-gateway/sandbox-config";
import { buildSandboxBunInstallCommand, SANDBOX_BUN_VERSION } from "./sandbox-bun";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("Pi runtime configuration", () => {
  test("pins the npm release corresponding to the reviewed upstream revision", async () => {
    expect(PI_BRIDGE_GENERATION).toBe(4);
    expect(PI_CODING_AGENT_VERSION).toBe("18.0.3");
    expect(PI_BUN_VERSION).toBe("1.3.14");
    expect(PI_CODING_AGENT_UPSTREAM_SHA).toBe("160ed439ac0df594347e7d7018b813a7ffdb5e81");
    expect(PI_RUNTIME_LOCK_SHA256).toHaveLength(64);
    const lock = await readFile(new URL("../../pi-runtime/package-lock.json", import.meta.url));
    const manifest = JSON.parse(await readFile(
      new URL("../../pi-runtime/package.json", import.meta.url),
      "utf8",
    )) as { dependencies: Record<string, string> };
    expect(manifest.dependencies.bun).toBe(PI_BUN_VERSION);
    expect(createHash("sha256").update(lock).digest("hex")).toBe(PI_RUNTIME_LOCK_SHA256);
    expect(piApiForProvider("openrouter")).toBe("openai-completions");
    expect(piModelSelection("google/gemini-3.7-flash")).toEqual({
      provider: "openrouter",
      modelId: "google/gemini-3.7-flash",
      selector: "openrouter/google/gemini-3.7-flash",
    });
  });

  test("repairs missing declared Cube Bun before accepting an ambiguous Pi install", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-pi-install-"));
    const manifest = join(root, "manifest");
    const current = join(root, "current");
    const fakeBin = join(root, "bin");
    const uploaded = join(root, "uploaded-bun");
    const bunExecutable = join(root, "usr/local/bin/bun");
    const executable = join(current, "pi.js");
    const lock = join(root, ".lock-sha256");
    const hostArch = process.arch === "arm64" ? "arm64" : "x64";
    try {
      await Promise.all([
        mkdir(manifest),
        mkdir(current),
        mkdir(fakeBin),
        mkdir(join(root, "usr/local/bin"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(manifest, "package.json"),
          await readFile(new URL("../../pi-runtime/package.json", import.meta.url)),
        ),
        writeFile(
          join(manifest, "package-lock.json"),
          await readFile(new URL("../../pi-runtime/package-lock.json", import.meta.url)),
        ),
        writeFile(executable, "current runtime\n"),
        writeFile(join(fakeBin, "npm"), "#!/bin/sh\nexit 42\n"),
        writeFile(
          uploaded,
          `#!/bin/sh\nif [ "$1" = --version ]; then echo ${SANDBOX_BUN_VERSION}; else echo omp/${PI_CODING_AGENT_VERSION}; fi\n`,
        ),
        writeFile(join(fakeBin, "uname"), [
          "#!/bin/sh",
          `test "$1" = -s && echo Linux || echo ${hostArch === "arm64" ? "aarch64" : "x86_64"}`,
          "",
        ].join("\n")),
        writeFile(join(fakeBin, "stat"), [
          "#!/bin/sh",
          "for path do :; done",
          "if /usr/bin/stat -c %a -- \"$path\" >/dev/null 2>&1; then exec /usr/bin/stat -c %a -- \"$path\"; fi",
          "exec /usr/bin/stat -f %Lp \"$path\"",
          "",
        ].join("\n")),
      ]);
      await Promise.all([
        chmod(join(fakeBin, "npm"), 0o755),
        chmod(join(fakeBin, "uname"), 0o700),
        chmod(join(fakeBin, "stat"), 0o700),
        chmod(uploaded, 0o700),
      ]);

      const sha256 = createHash("sha256").update(await readFile(uploaded)).digest("hex");
      const layout = { home: root, workdir: join(root, "work"), runsAsRoot: true, bunExecutable };
      expect(await Bun.file(bunExecutable).exists()).toBe(false);
      const repaired = Bun.spawnSync(
        ["sh", "-c", buildSandboxBunInstallCommand(layout, uploaded, hostArch, sha256)],
        { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` } },
      );
      expect(repaired.exitCode).toBe(0);

      const commands: string[] = [];
      await ensurePiRuntimeInstalled({
        process: {
          executeCommand: async (command) => {
            commands.push(command);
            const result = Bun.spawnSync(["sh", "-c", command], {
              env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
            });
            return { exitCode: result.exitCode, result: result.stderr.toString("utf8") };
          },
        },
        runtimeRoot: root,
        runtimeManifestDir: manifest,
        bunExecutable,
        executable,
      });

      expect(commands).toHaveLength(3);
      expect(commands[1]).toBe(
        buildPiRuntimeInstallCommand({
          runtimeRoot: root,
          runtimeManifestDir: manifest,
        }),
      );
      expect((await stat(bunExecutable)).mode & 0o777).toBe(0o755);
      expect(commands[2]).toContain(`'${bunExecutable}' --version`);
      expect(await readFile(lock, "utf8")).toBe(`${PI_RUNTIME_LOCK_SHA256}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a stale runtime without publishing a cache lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-pi-stale-"));
    const manifest = join(root, "manifest");
    const current = join(root, "current");
    const fakeBin = join(root, "bin");
    const bunExecutable = join(fakeBin, "bun");
    const executable = join(current, "pi.js");
    const lock = join(root, ".lock-sha256");
    try {
      await Promise.all([mkdir(manifest), mkdir(current), mkdir(fakeBin)]);
      await Promise.all([
        writeFile(
          join(manifest, "package.json"),
          await readFile(new URL("../../pi-runtime/package.json", import.meta.url)),
        ),
        writeFile(
          join(manifest, "package-lock.json"),
          await readFile(new URL("../../pi-runtime/package-lock.json", import.meta.url)),
        ),
        writeFile(join(current, "package-lock.json"), "stale\n"),
        writeFile(executable, "stale runtime\n"),
        writeFile(lock, `${PI_RUNTIME_LOCK_SHA256}\n`),
        writeFile(join(fakeBin, "npm"), "#!/bin/sh\nexit 42\n"),
        writeFile(bunExecutable, "#!/bin/sh\necho 0.0.0\n"),
      ]);
      await Promise.all([chmod(join(fakeBin, "npm"), 0o755), chmod(bunExecutable, 0o755)]);

      await expect(
        ensurePiRuntimeInstalled({
          process: {
            executeCommand: async (command) => {
              const result = Bun.spawnSync(["sh", "-c", command], {
                env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
              });
              return { exitCode: result.exitCode, result: result.stderr.toString("utf8") };
            },
          },
          runtimeRoot: root,
          runtimeManifestDir: manifest,
          bunExecutable,
          executable,
        }),
      ).rejects.toThrow("stage=verify Bun version mismatch");

      expect(await Bun.file(lock).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a Pi version that only shares the expected prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-pi-version-prefix-"));
    const manifest = join(root, "manifest");
    const current = join(root, "current");
    const fakeBin = join(root, "bin");
    const bunExecutable = join(fakeBin, "bun");
    const executable = join(current, "pi.js");
    const lock = join(root, ".lock-sha256");
    try {
      await Promise.all([mkdir(manifest), mkdir(current), mkdir(fakeBin)]);
      await Promise.all([
        writeFile(
          join(manifest, "package.json"),
          await readFile(new URL("../../pi-runtime/package.json", import.meta.url)),
        ),
        writeFile(
          join(manifest, "package-lock.json"),
          await readFile(new URL("../../pi-runtime/package-lock.json", import.meta.url)),
        ),
        writeFile(
          join(current, "package-lock.json"),
          await readFile(new URL("../../pi-runtime/package-lock.json", import.meta.url)),
        ),
        writeFile(executable, "prefix-matching runtime\n"),
        writeFile(join(fakeBin, "npm"), "#!/bin/sh\nexit 42\n"),
        writeFile(
          bunExecutable,
          "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.3.14; else echo omp/18.0.30; fi\n",
        ),
      ]);
      await Promise.all([chmod(join(fakeBin, "npm"), 0o755), chmod(bunExecutable, 0o755)]);

      await expect(
        ensurePiRuntimeInstalled({
          process: {
            executeCommand: async (command) => {
              const result = Bun.spawnSync(["sh", "-c", command], {
                env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
              });
              return { exitCode: result.exitCode, result: result.stderr.toString("utf8") };
            },
          },
          runtimeRoot: root,
          runtimeManifestDir: manifest,
          bunExecutable,
          executable,
        }),
      ).rejects.toThrow("stage=verify Pi version mismatch");

      expect(await Bun.file(lock).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports bounded install and verification stages for a true failure", async () => {
    const outcomes = [
      { exitCode: 10, result: "" },
      { exitCode: 42, result: `npm failed ${"x".repeat(300)}` },
      { exitCode: 21, result: "stage=verify package-lock mismatch" },
    ];

    await expect(
      ensurePiRuntimeInstalled({
        process: {
          executeCommand: mock(async () => outcomes.shift() ?? { exitCode: 1, result: "unexpected" }),
        },
        runtimeRoot: "/runtime",
        runtimeManifestDir: "/runtime/manifest",
        bunExecutable: "/usr/local/bin/bun",
        executable: "/runtime/current/pi.js",
      }),
    ).rejects.toThrow(
      /failed to install Pi 18\.0\.3 \(install exit 42: x{1,180}; verify exit 21: stage=verify package-lock mismatch\)/,
    );
  });

  test("accepts a current runtime with one verification RPC", async () => {
    const executeCommand = mock(async (_command: string) => ({ exitCode: 0, result: "" }));

    await ensurePiRuntimeInstalled({
      process: { executeCommand },
      runtimeRoot: "/runtime",
      runtimeManifestDir: "/runtime/manifest",
      bunExecutable: "/usr/local/bin/bun",
      executable: "/runtime/current/pi.js",
    });

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand.mock.calls[0]?.[0]).toContain("grep -Fxq");
    expect(executeCommand.mock.calls[0]?.[0]).not.toContain("npm ci");
  });

  test("refreshes per-turn config while keeping a warm current setup to five command RPCs", async () => {
    process.env.SANDBOX_SECRET_MODE = "gateway_only";
    process.env.PROVIDER_GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-secret-provider-secret-1234";
    process.env.GATEWAY_PUBLIC_URL = "https://tools.example.test";
    process.env.TOOL_GATEWAY_SECRET = "tools-secret-tools-secret-12345678";
    const uploads: Array<{ path: string; text: string }> = [];
    const commands: string[] = [];
    const sandbox = {
      id: "box",
      labels: { [SANDBOX_GENERATION_LABEL]: SANDBOX_GENERATION },
      fs: {
        uploadFile: mock(async (bytes: Buffer, path: string) => {
          uploads.push({ path, text: bytes.toString("utf8") });
        }),
      },
      process: {
        executeCommand: mock(async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "" };
        }),
      },
    } as never;

    for (const [runId, model] of [["run-1", "openai/gpt-5.6-sol"], ["run-2", "openai/gpt-5.6-luna"]]) {
      await preparePiRuntime(
        sandbox,
        {
          runId,
          threadId: "thread",
          orgId: "org",
          userId: "user",
          model,
          prompt: "clean user prompt",
        } as never,
        "/root/work",
      );
    }

    expect(commands).toHaveLength(10);
    expect(commands.filter((command) => command.includes("npm ci"))).toHaveLength(0);
    expect(commands.filter((command) => command.includes(".lock-sha256"))).toHaveLength(2);
    expect(uploads.filter((entry) => entry.path.endsWith("/models.json")).map((entry) => entry.text))
      .toEqual([
        expect.stringContaining('"id":"gpt-5.6-sol"'),
        expect.stringContaining('"id":"gpt-5.6-luna"'),
      ]);
    expect(uploads.filter((entry) => entry.path.endsWith("/.mcp.json"))).toHaveLength(2);
    expect(uploads.filter((entry) => entry.path.endsWith("/capabilities.json"))).toHaveLength(2);
  });

  test("keeps signed credentials behind the root broker and installs from the immutable lock", async () => {
    process.env.SANDBOX_SECRET_MODE = "gateway_only";
    process.env.PROVIDER_GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-secret-provider-secret-1234";
    process.env.GATEWAY_PUBLIC_URL = "https://tools.example.test";
    process.env.TOOL_GATEWAY_SECRET = "tools-secret-tools-secret-12345678";
    const uploads: Array<{ path: string; text: string }> = [];
    const commands: string[] = [];
    let gatewayMarkerWritten = false;
    let runtimeProbeCount = 0;
    const sandbox = {
      id: "box",
      labels: { [SANDBOX_GENERATION_LABEL]: SANDBOX_GENERATION },
      fs: {
        uploadFile: mock(async (bytes: Buffer, path: string) => {
          uploads.push({ path, text: bytes.toString("utf8") });
        }),
      },
      process: {
        executeCommand: mock(async (command: string) => {
          commands.push(command);
          if (command.includes("grep -Fxq") && command.includes(".lock-sha256") && runtimeProbeCount++ === 0) {
            return { exitCode: 10, result: "" };
          }
          if (command.includes(".skynet/provider-gateway-generation") && command.includes("base64 -d")) {
            gatewayMarkerWritten = true;
          }
          if (command.includes('test "$(cat $HOME/.skynet/provider-gateway-generation')) {
            return { exitCode: gatewayMarkerWritten ? 0 : 1, result: "" };
          }
          return { exitCode: 0, result: "" };
        }),
      },
    } as never;
    const runtime = await preparePiRuntime(
      sandbox,
      {
        runId: "run",
        threadId: "thread",
        orgId: "org",
        userId: "user",
        model: "openai/gpt-5.6-sol",
        prompt: "clean user prompt",
      } as never,
      "/root/work",
    );

    expect(runtime.model).toEqual({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      selector: "openai/gpt-5.6-sol",
    });
    const models = uploads.find((entry) => entry.path.endsWith("/models.json"));
    const mcp = uploads.find((entry) => entry.path.endsWith("/.mcp.json"));
    const brokerConfig = uploads.find((entry) => entry.path === "/root/.useagent/pi-broker/capabilities.json");
    expect(models?.path).toBe("/home/useagent-pi/agent/models.json");
    expect(models?.text).toContain("useagent-broker");
    expect(models?.text).not.toContain("Bearer ");
    expect(mcp?.text).toContain("http://127.0.0.1:19483/mcp");
    expect(mcp?.text).not.toContain("Authorization");
    expect(brokerConfig?.text).toContain("Bearer ");
    expect(commands.join("\n")).toContain("npm ci --omit=dev --silent");
    expect(commands.join("\n")).toContain(PI_RUNTIME_LOCK_SHA256);
    expect(gatewayMarkerWritten).toBe(true);
    expect(await providerGatewaySandboxIsCurrent(sandbox)).toBe(true);
    expect(commands.join("\n")).not.toContain("command -v bun");
    expect(commands.join("\n")).not.toContain("clean user prompt");
    expect(commands).toHaveLength(8);
    expect(runtime).toMatchObject({
      executable: "/opt/useagent/pi-runtime/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
      bunExecutable: "/opt/useagent/pi-runtime/current/node_modules/.bin/bun",
      runAsUser: "useagent-pi",
      home: "/home/useagent-pi",
    });
  });

  test("uses only user-writable Box paths and the current sandbox user", async () => {
    process.env.SANDBOX_SECRET_MODE = "gateway_only";
    process.env.PROVIDER_GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-secret-provider-secret-1234";
    process.env.GATEWAY_PUBLIC_URL = "https://tools.example.test";
    process.env.TOOL_GATEWAY_SECRET = "tools-secret-tools-secret-12345678";
    const uploads: Array<{ path: string; text: string }> = [];
    const commands: string[] = [];
    const sandbox = {
      id: "box",
      labels: { [SANDBOX_GENERATION_LABEL]: SANDBOX_GENERATION },
      fs: {
        uploadFile: mock(async (bytes: Buffer, path: string) => {
          uploads.push({ path, text: bytes.toString("utf8") });
        }),
      },
      process: {
        executeCommand: mock(async (command: string) => {
          commands.push(command);
          if (command.startsWith("grep -Fxq") && command.includes(".lock-sha256")) {
            return { exitCode: 10, result: "" };
          }
          return { exitCode: 0, result: "" };
        }),
      },
    } as never;

    const runtime = await preparePiRuntime(
      sandbox,
      {
        runId: "run",
        threadId: "thread",
        orgId: "org",
        userId: "user",
        model: "openai/gpt-5.6-sol",
        prompt: "clean user prompt",
        signal: new AbortController().signal,
      } as never,
      "/home/user/work",
      {
        home: "/home/user",
        workdir: "/home/user/work",
        runsAsRoot: false,
        bunExecutable: "/usr/local/bin/bun",
      },
    );

    expect(runtime).toMatchObject({
      executable: "/home/user/.useagent/pi-runtime/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
      bunExecutable: "/usr/local/bin/bun",
      runAsUser: null,
      home: "/home/user/.useagent/pi",
    });
    expect(uploads.map((entry) => entry.path)).toContain(
      "/home/user/.useagent/pi-broker/capabilities.json",
    );
    const commandText = commands.join("\n");
    expect(commandText).toContain("/home/user/work");
    expect(commandText).toContain("/home/user/.useagent/pi-runtime");
    expect(commandText).toContain(
      "test -x '/usr/local/bin/bun' && test \"$(stat -c %a -- '/usr/local/bin/bun')\" = '755'",
    );
    expect(commandText.indexOf("test -x '/usr/local/bin/bun'")).toBeLessThan(
      commandText.indexOf("/home/user/.useagent/pi-runtime/.lock-sha256"),
    );
    expect(commandText).toContain("'/usr/local/bin/bun' --version | grep -Fxq '1.3.14'");
    expect(commandText.lastIndexOf(".lock-sha256")).toBeGreaterThan(
      commandText.indexOf("--version | grep -Fq '18.0.3'"),
    );
    expect(commandText).toContain(
      "rm -f '/home/user/.useagent/pi-runtime/.lock-sha256'; printf '%s\\n' 'stage=verify",
    );
    expect(commandText).not.toContain("useradd");
    expect(commandText).not.toContain("chown");
    expect(commandText).not.toContain("/root");
    expect(commandText).not.toContain("/opt");
    expect(commandText).not.toContain("clean user prompt");
    expect(commands).toHaveLength(6);
  });
});
