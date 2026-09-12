import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface NativeRuntimeManifest {
  readonly archiveName: string;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly sourceCommit: string;
  readonly dependencyVersion: string;
  readonly dependencyLockSha256: string;
}

const RELEASE_TAG = "v0.0.4";
const RELEASE_REPOSITORY = "useagenthq/useagent-pro";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(repoRoot, "backend/runtime-assets/manifest.json");
const dependencyPackagePath = join(repoRoot, "backend/runtime-assets/dependencies/package.json");
const dependencyLockPath = join(repoRoot, "backend/runtime-assets/dependencies/bun.lock");

function requireMatch(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`native runtime manifest has invalid ${field}`);
  }
  return value;
}

async function readManifest(): Promise<NativeRuntimeManifest> {
  const value: unknown = await Bun.file(manifestPath).json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("native runtime manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    archiveName: requireMatch(
      record.archiveName,
      /^native-runtime-[0-9a-f]{12}\.tar\.gz$/,
      "archiveName",
    ),
    archiveSha256: requireMatch(record.archiveSha256, /^[0-9a-f]{64}$/, "archiveSha256"),
    manifestSha256: requireMatch(
      record.manifestSha256,
      /^[0-9a-f]{64}$/,
      "manifestSha256",
    ),
    sourceCommit: requireMatch(record.sourceCommit, /^[0-9a-f]{40}$/, "sourceCommit"),
    dependencyVersion: requireMatch(
      record.dependencyVersion,
      /^[0-9]+\.[0-9]+\.[0-9]+$/,
      "dependencyVersion",
    ),
    dependencyLockSha256: requireMatch(
      record.dependencyLockSha256,
      /^[0-9a-f]{64}$/,
      "dependencyLockSha256",
    ),
  };
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function capture(command: string[], cwd = repoRoot): Promise<Uint8Array> {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).bytes(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim() || "no error output"}`);
  }
  return stdout;
}

async function verifyArchive(path: string, manifest: NativeRuntimeManifest): Promise<void> {
  const archiveHash = await sha256(path);
  if (archiveHash !== manifest.archiveSha256) {
    throw new Error(
      `native runtime archive hash mismatch: expected ${manifest.archiveSha256}, got ${archiveHash}`,
    );
  }
  const sourceCommit = new TextDecoder()
    .decode(await capture(["tar", "-xOzf", path, "./T3_SOURCE_COMMIT"]))
    .trim();
  if (sourceCommit !== manifest.sourceCommit) {
    throw new Error(
      `native runtime source mismatch: expected ${manifest.sourceCommit}, got ${sourceCommit}`,
    );
  }
  const checksumManifest = await capture(["tar", "-xOzf", path, "./SHA256SUMS"]);
  const checksumHash = createHash("sha256").update(checksumManifest).digest("hex");
  if (checksumHash !== manifest.manifestSha256) {
    throw new Error(
      `native runtime checksum manifest mismatch: expected ${manifest.manifestSha256}, got ${checksumHash}`,
    );
  }
}

async function verifyDependencyLock(manifest: NativeRuntimeManifest): Promise<void> {
  const lockHash = await sha256(dependencyLockPath);
  if (lockHash !== manifest.dependencyLockSha256) {
    throw new Error(
      `native runtime dependency lock mismatch: expected ${manifest.dependencyLockSha256}, got ${lockHash}`,
    );
  }
  const packageJson: unknown = await Bun.file(dependencyPackagePath).json();
  const dependency = packageJson && typeof packageJson === "object" && !Array.isArray(packageJson)
    ? (packageJson as { dependencies?: Record<string, unknown> }).dependencies?.t3
    : undefined;
  if (dependency !== manifest.dependencyVersion) {
    throw new Error(
      `native runtime dependency version mismatch: expected ${manifest.dependencyVersion}, got ${String(dependency)}`,
    );
  }
}

async function downloadArchive(directory: string, archiveName: string): Promise<string> {
  const process = Bun.spawn([
    "gh",
    "release",
    "download",
    RELEASE_TAG,
    "--repo",
    RELEASE_REPOSITORY,
    "--pattern",
    archiveName,
    "--dir",
    directory,
  ], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`failed to download ${archiveName} from ${RELEASE_REPOSITORY} ${RELEASE_TAG}`);
  }
  return join(directory, archiveName);
}

async function main(): Promise<void> {
  const inputs = Bun.argv.slice(2);
  if (inputs.length > 1) {
    throw new Error("usage: bun run deploy/stage-native-runtime.ts [local-archive]");
  }
  const manifest = await readManifest();
  await verifyDependencyLock(manifest);
  if (basename(manifest.archiveName) !== manifest.archiveName) {
    throw new Error("native runtime archiveName must be a filename");
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "useagent-native-runtime-"));
  try {
    const source = inputs[0]
      ? resolve(process.cwd(), inputs[0])
      : await downloadArchive(temporaryDirectory, manifest.archiveName);
    await verifyArchive(source, manifest);

    const destination = join(repoRoot, "backend/runtime-assets", manifest.archiveName);
    if (await Bun.file(destination).exists()) {
      const existingHash = await sha256(destination);
      if (existingHash !== manifest.archiveSha256) {
        throw new Error(`refusing to replace ${destination}: existing file has a different hash`);
      }
      console.log(`Native runtime already staged: ${destination}`);
      return;
    }

    await mkdir(dirname(destination), { recursive: true });
    const temporaryDestination = `${destination}.tmp-${process.pid}`;
    await copyFile(source, temporaryDestination);
    try {
      await verifyArchive(temporaryDestination, manifest);
      await rename(temporaryDestination, destination);
    } finally {
      await rm(temporaryDestination, { force: true });
    }
    console.log(`Staged ${manifest.archiveName}`);
    console.log(`Archive SHA256: ${manifest.archiveSha256}`);
    console.log(`Source commit: ${manifest.sourceCommit}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
