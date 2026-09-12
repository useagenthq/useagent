import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { daytonaPlugin } from "@useagent/sandbox-daytona";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  SANDBOX_BUN_VERSION,
  buildSandboxBunInstallCommand,
  buildSandboxBunProbeCommand,
  ensureSandboxBun,
} from "./sandbox-bun";

function hostArch(): "arm64" | "x64" {
  return process.arch === "arm64" ? "arm64" : "x64";
}

async function linuxCommandEnvironment(home: string): Promise<Record<string, string | undefined>> {
  const tools = join(home, "tools");
  await mkdir(tools);
  await Bun.write(join(tools, "uname"), [
    "#!/bin/sh",
    `test "$1" = -s && printf '%s\\n' Linux || printf '%s\\n' ${hostArch() === "arm64" ? "aarch64" : "x86_64"}`,
    "",
  ].join("\n"));
  await Bun.write(join(tools, "stat"), [
    "#!/bin/sh",
    "for path do :; done",
    "if /usr/bin/stat -c %a -- \"$path\" >/dev/null 2>&1; then exec /usr/bin/stat -c %a -- \"$path\"; fi",
    "exec /usr/bin/stat -f %Lp \"$path\"",
    "",
  ].join("\n"));
  await Promise.all([
    chmod(join(tools, "uname"), 0o700),
    chmod(join(tools, "stat"), 0o700),
  ]);
  return { ...process.env, PATH: `${tools}:${process.env.PATH ?? ""}` };
}

describe("sandbox Bun prerequisite", () => {
  test("reuses the Bun baked into Daytona's shared native image without an upload", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "useagent-daytona-baked-bun-"));
    try {
      const executable = join(fixtureRoot, "baked-bun");
      await Bun.write(executable, `#!/bin/sh\nprintf '%s\\n' '${SANDBOX_BUN_VERSION}'\n`);
      await chmod(executable, 0o755);
      const env = await linuxCommandEnvironment(fixtureRoot);
      let calls = 0;
      const sandbox = {
        process: {
          async executeCommand(command: string) {
            calls++;
            const result = Bun.spawnSync(["sh", "-c", command.replaceAll("/usr/local/bin/bun", executable)], { env });
            return { exitCode: result.exitCode, result: result.stdout.toString() };
          },
        },
      } as SandboxHandle;
      await ensureSandboxBun(sandbox, { ...daytonaPlugin.runtime, runsAsRoot: daytonaPlugin.runsAsRoot }, new AbortController().signal);
      expect(calls).toBe(1);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("publishes root-prepared Bun for non-root runtime users without changing a retained workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "useagent-sandbox-bun-"));
    const workdir = join(home, "work");
    const uploaded = join(home, "uploaded-bun");
    const executable = join(home, ".local/bin/bun");
    const layout = { home, workdir, runsAsRoot: true, bunExecutable: executable };
    try {
      await mkdir(workdir);
      await Bun.write(join(workdir, "retained.txt"), "keep me\n");
      await Bun.write(uploaded, `#!/bin/sh\nprintf '%s\\n' '${SANDBOX_BUN_VERSION}'\n`);
      await chmod(uploaded, 0o700);
      const sha256 = createHash("sha256").update(await readFile(uploaded)).digest("hex");
      const env = await linuxCommandEnvironment(home);

      expect(Bun.spawnSync(["sh", "-c", buildSandboxBunProbeCommand(layout)]).exitCode).not.toBe(0);
      const installed = Bun.spawnSync([
        "sh",
        "-c",
        buildSandboxBunInstallCommand(layout, uploaded, hostArch(), sha256),
      ], { env });

      expect(installed.exitCode).toBe(0);
      expect(Bun.spawnSync(
        ["sh", "-c", buildSandboxBunProbeCommand(layout)],
        { env },
      ).exitCode).toBe(0);
      expect((await stat(executable)).mode & 0o777).toBe(0o755);
      expect((await stat(uploaded)).mode & 0o777).toBe(0o700);
      expect(await readFile(join(workdir, "retained.txt"), "utf8")).toBe("keep me\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("rejects corruption before replacing an existing executable", async () => {
    const home = await mkdtemp(join(tmpdir(), "useagent-sandbox-bun-corrupt-"));
    const uploaded = join(home, "uploaded-bun");
    const executable = join(home, "bin/bun");
    const layout = { home, workdir: join(home, "work"), runsAsRoot: false, bunExecutable: executable };
    try {
      await mkdir(join(home, "bin"));
      await Bun.write(executable, "existing executable\n");
      await Bun.write(uploaded, "corrupt upload\n");
      await chmod(executable, 0o755);
      await chmod(uploaded, 0o700);
      const command = buildSandboxBunInstallCommand(layout, uploaded, hostArch(), "0".repeat(64));

      expect(Bun.spawnSync(["sh", "-c", command]).exitCode).not.toBe(0);
      expect(await readFile(executable, "utf8")).toBe("existing executable\n");
      expect((await stat(executable)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("rejects a different sandbox architecture before replacing Bun", async () => {
    const home = await mkdtemp(join(tmpdir(), "useagent-sandbox-bun-arch-"));
    const uploaded = join(home, "uploaded-bun");
    const executable = join(home, "bin/bun");
    const layout = { home, workdir: join(home, "work"), runsAsRoot: false, bunExecutable: executable };
    try {
      await mkdir(join(home, "bin"));
      await Bun.write(executable, "existing executable\n");
      await Bun.write(uploaded, `#!/bin/sh\nprintf '%s\\n' '${SANDBOX_BUN_VERSION}'\n`);
      await chmod(executable, 0o700);
      await chmod(uploaded, 0o700);
      const sha256 = createHash("sha256").update(await readFile(uploaded)).digest("hex");
      const wrongArch = hostArch() === "arm64" ? "x64" : "arm64";
      const env = await linuxCommandEnvironment(home);

      expect(Bun.spawnSync([
        "sh",
        "-c",
        buildSandboxBunInstallCommand(layout, uploaded, wrongArch, sha256),
      ], { env }).exitCode).toBe(42);
      expect(await readFile(executable, "utf8")).toBe("existing executable\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
