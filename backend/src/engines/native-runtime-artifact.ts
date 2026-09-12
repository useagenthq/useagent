import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import manifest from "../../runtime-assets/manifest.json";
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { ensureSandboxBun, sandboxBunExecutable } from "./sandbox-bun";

export const NATIVE_RUNTIME_ARTIFACT = manifest;
const CHUNK_BYTES = 3 * 1024 * 1024;
type ArtifactSandbox = {
  readonly process: Pick<SandboxHandle["process"], "executeCommand">;
  readonly fs?: Pick<SandboxHandle["fs"], "uploadFile">;
};

function q(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function nativeRuntimeExecutable(layout: SandboxRuntimeLayout): string {
  return `${layout.home}/.local/share/useagent/native-runtime/${manifest.sourceCommit}/bin/t3`;
}

/** Verify the fork's contents, not the public package's shared version string. */
function verifyDist(dist: string): string {
  return [
    `test "$(cat ${q(`${dist}/T3_SOURCE_COMMIT`)} 2>/dev/null)" = ${q(manifest.sourceCommit)}`,
    `printf '%s  %s\\n' ${q(manifest.manifestSha256)} ${q(`${dist}/SHA256SUMS`)} | sha256sum -c - >/dev/null`,
    `(cd ${q(dist)} && sha256sum -c SHA256SUMS >/dev/null 2>&1)`,
  ].join(" && ");
}

function verifyDependencies(root: string): string {
  return [
    `printf '%s  %s\\n' ${q(manifest.dependencyLockSha256)} ${q(`${root}/bun.lock`)} | sha256sum -c - >/dev/null`,
    `(cd ${q(root)} && sha256sum -c .native-dependencies.sha256 >/dev/null 2>&1)`,
    `(cd ${q(root)} && test "$(find node_modules -type l -printf '%p\\t%l\\n' | LC_ALL=C sort)" = "$(cat .native-dependency-links)")`,
  ].join(" && ");
}

export function buildNativeRuntimeArtifactProbe(layout: SandboxRuntimeLayout): string {
  const root = nativeRuntimeExecutable(layout).replace(/\/bin\/t3$/, "");
  return [
    "# native-runtime-verified",
    `test -x ${q(`${root}/bin/t3`)} &&`,
    `printf '%s  %s\\n' ${q(
      createHash("sha256")
        .update(launcherScript(`${root}/dist`))
        .digest("hex"),
    )} ${q(`${root}/bin/t3`)} | sha256sum -c - >/dev/null &&`,
    `test "$(readlink ${q(`${root}/dist`)})" = node_modules/t3/dist &&`,
    `${verifyDist(`${root}/dist`)} &&`,
    verifyDependencies(root),
  ].join("\n");
}

function launcherScript(dist: string): string {
  // No provider credentials or per-turn settings enter the file.
  return `#!/bin/sh\nexec node ${q(`${dist}/bin.mjs`)} "$@"\n`;
}

function publishLauncher(root: string): string {
  return [
    `mkdir -p ${q(`${root}/bin`)}`,
    `printf '%s' ${q(launcherScript(`${root}/dist`))} > ${q(`${root}/bin/t3`)}`,
    `chmod 700 ${q(`${root}/bin/t3`)}`,
  ].join("\n");
}

export function buildNativeRuntimeInstallCommand(
  layout: SandboxRuntimeLayout,
  staging: string,
  chunkPaths: readonly string[],
): string {
  const root = nativeRuntimeExecutable(layout).replace(/\/bin\/t3$/, "");
  const archive = `${staging}/runtime.tar.gz`;
  const packageRoot = `${staging}/dependencies/node_modules/t3`;
  return [
    "set -eu",
    `export HOME=${q(layout.home)}`,
    `cat ${chunkPaths.map(q).join(" ")} > ${q(archive)}`,
    `printf '%s  %s\\n' ${q(manifest.archiveSha256)} ${q(archive)} | sha256sum -c - >/dev/null`,
    `mkdir -p ${q(`${staging}/dependencies`)}`,
    // The registry package supplies platform-specific external dependencies
    // only. Its public dist is never executed; the verified fork replaces it.
    `cd ${q(`${staging}/dependencies`)}`,
    `printf '%s  %s\\n' ${q(manifest.dependencyLockSha256)} bun.lock | sha256sum -c - >/dev/null`,
    `BUN_INSTALL_CACHE_DIR=${q(`${staging}/cache`)} ${q(sandboxBunExecutable(layout))} install --frozen-lockfile --ignore-scripts --no-progress`,
    // Bun owns installation; use the existing Node toolchain only for its native addon.
    `node_gyp=$(node -e ${q('const fs=require("node:fs"),p=require("node:path");console.log(require.resolve("node-gyp/bin/node-gyp.js",{paths:[p.dirname(fs.realpathSync(process.argv[1]))]}))')} "$(command -v npm)")`,
    `(cd node_modules/node-pty && { node scripts/prebuild.js || node "$node_gyp" rebuild; } && node scripts/post-install.js)`,
    `test -d ${q(`${packageRoot}/dist`)}`,
    `mv ${q(`${packageRoot}/dist`)} ${q(`${staging}/public-dist`)}`,
    `mkdir ${q(`${packageRoot}/dist`)}`,
    `tar -xzf ${q(archive)} -C ${q(`${packageRoot}/dist`)}`,
    `${verifyDist(`${packageRoot}/dist`)} || exit 1`,
    // Detect accidental file/topology corruption. This is not remote attestation
    // against tenant code with full access to the sandbox's process environment.
    "find node_modules -type f -print0 | sort -z | xargs -0 sha256sum > .native-dependencies.sha256",
    "find node_modules -type l -printf '%p\\t%l\\n' | LC_ALL=C sort > .native-dependency-links",
    // Move the entire dependency tree, preserving node module resolution.
    `test ! -e ${q(root)}`,
    `mv ${q(`${staging}/dependencies`)} ${q(root)}`,
    `ln -s node_modules/t3/dist ${q(`${root}/dist`)}`,
    publishLauncher(root),
    `test "$( ${q(`${root}/bin/t3`)} --version)" = ${q(`t3 v${manifest.dependencyVersion}`)}`,
    buildNativeRuntimeArtifactProbe(layout),
  ].join("\n");
}

let packagedArchive: Promise<Buffer> | undefined;
async function loadPackagedArchive(): Promise<Buffer> {
  packagedArchive ??= (async () => {
    const bytes = await readFile(
      new URL(`../../runtime-assets/${manifest.archiveName}`, import.meta.url),
    );
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.archiveSha256) {
      throw new Error("Packaged native runtime failed its archive checksum");
    }
    return bytes;
  })().catch((error) => {
    packagedArchive = undefined;
    throw error;
  });
  return packagedArchive;
}

export async function ensureNativeRuntimeArtifact(
  sandbox: ArtifactSandbox,
  layout: SandboxRuntimeLayout,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const execute = (command: string, timeout = 15) =>
    sandbox.process.executeCommand(command, undefined, undefined, timeout);
  if ((await execute(buildNativeRuntimeArtifactProbe(layout))).exitCode === 0) return;
  if (!sandbox.fs)
    throw new Error("Native runtime artifact upload is unavailable for this sandbox");
  const node = await execute(
    "node -e 'const [major,minor]=process.versions.node.split(\".\").map(Number);process.exit((major===22&&minor>=16)||(major===23&&minor>=11)||(major===24&&minor>=10)||major>24?0:1)'",
    10,
  );
  if (node.exitCode !== 0)
    throw new Error("Native runtime requires Node 22.16+, 23.11+, or 24.10+ in the sandbox");
  await ensureSandboxBun(sandbox, layout, signal);
  const bytes = await loadPackagedArchive();
  const lock = await readFile(
    new URL("../../runtime-assets/dependencies/bun.lock", import.meta.url),
  );
  const packageJson = await readFile(
    new URL("../../runtime-assets/dependencies/package.json", import.meta.url),
  );
  if (createHash("sha256").update(lock).digest("hex") !== manifest.dependencyLockSha256) {
    throw new Error("Packaged native runtime dependency lock failed its checksum");
  }
  signal.throwIfAborted();
  const parent = `${layout.home}/.local/share/useagent/native-runtime`;
  const staging = `${parent}/.stage-${randomUUID()}`;
  const root = nativeRuntimeExecutable(layout).replace(/\/bin\/t3$/, "");
  const prepare = await execute(
    [
      "set -eu",
      `mkdir -p ${q(parent)}`,
      `mkdir -m 700 ${q(staging)}`,
      // Retain a failed installation only inside this operation's bounded stage.
      `if [ -e ${q(root)} ]; then mv ${q(root)} ${q(`${staging}/rejected`)}; fi`,
      `mkdir ${q(`${staging}/dependencies`)}`,
    ].join("\n"),
  );
  if (prepare.exitCode !== 0)
    throw new Error("Native runtime staging directory could not be prepared");
  try {
    await sandbox.fs.uploadFile(lock, `${staging}/dependencies/bun.lock`);
    await sandbox.fs.uploadFile(packageJson, `${staging}/dependencies/package.json`);
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      signal.throwIfAborted();
      const path = `${staging}/part-${chunks.length}`;
      await sandbox.fs.uploadFile(bytes.subarray(offset, offset + CHUNK_BYTES), path);
      chunks.push(path);
    }
    signal.throwIfAborted();
    const installed = await execute(buildNativeRuntimeInstallCommand(layout, staging, chunks), 180);
    if (installed.exitCode !== 0) {
      throw new Error(
        `Native runtime artifact installation failed (exit ${installed.exitCode ?? "unknown"})`,
      );
    }
    signal.throwIfAborted();
  } finally {
    // Only this operation's generated staging directory; never shared caches.
    await execute(`rm -rf -- ${q(staging)}`).catch(() => {});
  }
}
