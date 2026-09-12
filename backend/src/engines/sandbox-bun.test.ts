import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  SANDBOX_BUN_VERSION,
  buildSandboxBunInstallCommand,
  buildSandboxBunProbeCommand,
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
  await chmod(join(tools, "uname"), 0o700);
  return { ...process.env, PATH: `${tools}:${process.env.PATH ?? ""}` };
}

describe("sandbox Bun prerequisite", () => {
  test("installs the pinned executable without changing a retained workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "useagent-sandbox-bun-"));
    const workdir = join(home, "work");
    const uploaded = join(home, "uploaded-bun");
    const executable = join(home, ".local/bin/bun");
    const layout = { home, workdir, runsAsRoot: false, bunExecutable: executable };
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
      expect(Bun.spawnSync(["sh", "-c", buildSandboxBunProbeCommand(layout)]).exitCode).toBe(0);
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
      await chmod(executable, 0o700);
      await chmod(uploaded, 0o700);
      const command = buildSandboxBunInstallCommand(layout, uploaded, hostArch(), "0".repeat(64));

      expect(Bun.spawnSync(["sh", "-c", command]).exitCode).not.toBe(0);
      expect(await readFile(executable, "utf8")).toBe("existing executable\n");
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
