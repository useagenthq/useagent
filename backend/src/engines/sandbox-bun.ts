import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";

export const SANDBOX_BUN_VERSION = "1.3.14";

type BunSandbox = {
  readonly process: Pick<SandboxHandle["process"], "executeCommand">;
  readonly fs?: Pick<SandboxHandle["fs"], "uploadFile">;
};

type BunArtifact = {
  readonly bytes: Buffer;
  readonly arch: "arm64" | "x64";
  readonly sha256: string;
};

function q(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function linuxArch(value: string): BunArtifact["arch"] | null {
  if (value === "x64" || value === "x86_64" || value === "amd64") return "x64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  return null;
}

export function sandboxBunExecutable(layout: SandboxRuntimeLayout): string {
  return layout.bunExecutable ?? `${layout.home}/.local/bin/bun`;
}

export function buildSandboxBunProbeCommand(layout: SandboxRuntimeLayout): string {
  const executable = sandboxBunExecutable(layout);
  return (
    `test -x ${q(executable)} && ` +
    `test "$(stat -c %a -- ${q(executable)})" = '755' && ` +
    `test "$(${q(executable)} --version)" = ${q(SANDBOX_BUN_VERSION)}`
  );
}

export function buildSandboxBunInstallCommand(
  layout: SandboxRuntimeLayout,
  uploadedPath: string,
  expectedArch: BunArtifact["arch"],
  sha256: string,
): string {
  const executable = sandboxBunExecutable(layout);
  const stageId = uploadedPath.slice(0, uploadedPath.lastIndexOf("/")).split("/").at(-1);
  const temporaryExecutable = `${executable}.useagent-new-${stageId}`;
  const remoteArchCheck = expectedArch === "x64"
    ? 'case "$(uname -m)" in x86_64|amd64) ;; *) exit 42 ;; esac'
    : 'case "$(uname -m)" in arm64|aarch64) ;; *) exit 42 ;; esac';
  return [
    "set -eu",
    'test "$(uname -s)" = Linux',
    remoteArchCheck,
    `printf '%s  %s\\n' ${q(sha256)} ${q(uploadedPath)} | sha256sum -c - >/dev/null`,
    `mkdir -p ${q(executable.slice(0, executable.lastIndexOf("/")))}`,
    `cleanup_sandbox_bun() { rm -f -- ${q(temporaryExecutable)}; }`,
    "trap cleanup_sandbox_bun EXIT HUP INT TERM",
    `install -m 700 ${q(uploadedPath)} ${q(temporaryExecutable)}`,
    `test "$(${q(temporaryExecutable)} --version)" = ${q(SANDBOX_BUN_VERSION)}`,
    `chmod 755 ${q(temporaryExecutable)}`,
    `mv -f ${q(temporaryExecutable)} ${q(executable)}`,
    "trap - EXIT HUP INT TERM",
    buildSandboxBunProbeCommand(layout),
  ].join("\n");
}

let packagedBun: Promise<BunArtifact> | undefined;

async function loadPackagedBun(): Promise<BunArtifact> {
  packagedBun ??= (async () => {
    if (process.platform !== "linux" || Bun.version !== SANDBOX_BUN_VERSION) {
      throw new Error(`Sandbox Bun bootstrap requires backend Bun ${SANDBOX_BUN_VERSION} on Linux`);
    }
    const arch = linuxArch(process.arch);
    if (!arch) throw new Error(`Sandbox Bun bootstrap does not support backend architecture ${process.arch}`);
    const bytes = await readFile(process.execPath);
    return {
      bytes,
      arch,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  })().catch((error) => {
    packagedBun = undefined;
    throw error;
  });
  return packagedBun;
}

export async function ensureSandboxBun(
  sandbox: BunSandbox,
  layout: SandboxRuntimeLayout,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const execute = (command: string, timeout = 15) =>
    sandbox.process.executeCommand(command, undefined, undefined, timeout);
  if ((await execute(buildSandboxBunProbeCommand(layout))).exitCode === 0) return;
  if (!sandbox.fs) throw new Error("Sandbox Bun bootstrap upload is unavailable");

  const remote = await execute("set -eu; test \"$(uname -s)\" = Linux; uname -m", 10);
  const remoteArch = linuxArch(remote.result?.trim() ?? "");
  if (remote.exitCode !== 0 || !remoteArch) {
    throw new Error("Sandbox Bun bootstrap requires a supported Linux architecture");
  }
  const artifact = await loadPackagedBun();
  if (remoteArch !== artifact.arch) {
    throw new Error(`Sandbox Bun architecture mismatch: backend=${artifact.arch} sandbox=${remoteArch}`);
  }

  signal.throwIfAborted();
  const stage = `${layout.home}/.local/share/useagent/bun/.stage-${randomUUID()}`;
  const uploadedPath = `${stage}/bun`;
  const prepared = await execute(`mkdir -p ${q(stage)} && chmod 700 ${q(stage)}`);
  if (prepared.exitCode !== 0) throw new Error("Sandbox Bun staging directory could not be prepared");
  try {
    await sandbox.fs.uploadFile(artifact.bytes, uploadedPath, 120);
    signal.throwIfAborted();
    const installed = await execute(
      buildSandboxBunInstallCommand(layout, uploadedPath, artifact.arch, artifact.sha256),
      60,
    );
    if (installed.exitCode !== 0) {
      throw new Error(`Sandbox Bun bootstrap failed (exit ${installed.exitCode ?? "unknown"})`);
    }
  } finally {
    await execute(`rm -rf -- ${q(stage)}`).catch(() => {});
  }
}
