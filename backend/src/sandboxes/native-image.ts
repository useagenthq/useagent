// The native image: one recipe for everything a fresh sandbox otherwise installs
// at the start of a run. Bun, the native runtime (the T3 fork and its
// dependencies), the codex, claude and opencode drivers, the Pi runtime, and
// the document toolchain (LibreOffice, fonts, the Python office libraries).
//
// Every step is the same shell the run-time repair path uses, so a sandbox
// born from the image passes each probe and the run only boots the runtime
// server. The recipe renders two ways: applied to a live sandbox (Box saves the
// result as a named snapshot) or as a Dockerfile with its build context (Cube
// registers the built image as a template). The image name is a fingerprint of
// every input, so a new runtime, driver, Pi lock or toolchain bakes a new name
// and the old image keeps serving until the deployment points at the new one.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SandboxFileSystem, SandboxProcess } from "@useagent/sandbox-contract";
import type { SandboxRuntimeLayout } from "./provider";
import {
  buildNativeRuntimeArtifactProbe,
  buildNativeRuntimeInstallCommand,
  NATIVE_RUNTIME_ARTIFACT,
} from "../engines/native-runtime-artifact";
import {
  buildPiRuntimeEnsureCommand,
  PI_RUNTIME_LOCK_SHA256,
  PI_RUNTIME_ROOT,
} from "../engines/pi-runtime-config";
import {
  buildRuntimeProviderBootstrapCommand,
  RUNTIME_ENGINE_VERSIONS,
} from "../engines/runtime-provider-bridge";
import {
  buildSandboxBunInstallCommand,
  buildSandboxBunProbeCommand,
  SANDBOX_BUN_VERSION,
} from "../engines/sandbox-bun";
import { claudeProviderGatewayEnvironment } from "../provider-gateway/sandbox-config";
import { DESKTOP_REQUIRED_BINARIES } from "../engines/desktop-workstation";

/** Bump when a step changes in a way the fingerprinted inputs cannot express. */
const NATIVE_IMAGE_RECIPE_VERSION = 2;
/** Box accepts uploads of a few MB; larger files travel in parts and are joined in the sandbox. */
const UPLOAD_PART_BYTES = 3 * 1024 * 1024;
const NATIVE_ENGINES = ["codex", "claude", "opencode"] as const;

export interface NativeImageInputs {
  /** Linux Bun binary at SANDBOX_BUN_VERSION (the backend's own, on Linux). */
  readonly bun: { readonly bytes: Buffer; readonly arch: "x64" | "arm64" };
  readonly runtimeArchive: Buffer;
  readonly runtimeDependencyLock: Buffer;
  readonly runtimeDependencyPackage: Buffer;
  readonly piPackage: Buffer;
  readonly piLock: Buffer;
  /** ANTHROPIC_BASE_URL and CLAUDE_CONFIG_DIR for the Claude driver's wrapper; empty skips Claude. */
  readonly claudeEnvironment: Readonly<Record<string, string>>;
}

export interface NativeImageFile {
  /** Absolute path inside the sandbox. */
  readonly path: string;
  readonly bytes: Buffer;
}

export interface NativeImageStep {
  readonly name: string;
  readonly files: readonly NativeImageFile[];
  /** A complete `set -eu` script; exit 0 also when the step's probe already passes. */
  readonly command: string;
  readonly timeoutSeconds: number;
}

function q(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A multi-line probe as one `if` condition: drop its comment lines, join the rest. */
function oneLine(script: string): string {
  return script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join(" ");
}

export function documentToolchainCommand(layout: SandboxRuntimeLayout): string {
  const sudo = layout.runsAsRoot ? "" : "sudo -n ";
  return [
    "if command -v soffice >/dev/null 2>&1 && python3 -c 'import reportlab, xlsxwriter, openpyxl, pptx' >/dev/null 2>&1; then exit 0; fi",
    "export DEBIAN_FRONTEND=noninteractive",
    `${sudo}apt-get update -qq`,
    `${sudo}apt-get install -y -qq --no-install-recommends libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress fonts-liberation fonts-dejavu fonts-noto-core`,
    `${sudo}rm -rf /var/lib/apt/lists/*`,
    `${sudo}ln -sf /usr/bin/soffice /usr/local/bin/soffice`,
    `${sudo}pip3 install --quiet --no-cache-dir --break-system-packages reportlab xlsxwriter openpyxl python-pptx`,
    "soffice --headless --version >/dev/null",
    "python3 -c 'import reportlab, xlsxwriter, openpyxl, pptx'",
  ].join("\n");
}

/** Use the runtime's desktop contract when baking and checking an image. */
export function desktopToolchainProbeCommand(): string {
  return [
    ...DESKTOP_REQUIRED_BINARIES.map((binary) => `command -v ${binary} >/dev/null 2>&1`),
    "(command -v google-chrome || command -v chromium || command -v chromium-browser) >/dev/null 2>&1",
    "test -r /usr/share/novnc/vnc.html",
  ].join(" && ");
}

export function desktopToolchainCommand(layout: SandboxRuntimeLayout): string {
  const sudo = layout.runsAsRoot ? "" : "sudo -n ";
  const probe = desktopToolchainProbeCommand();
  return [
    `if ${probe}; then exit 0; fi`,
    "export DEBIAN_FRONTEND=noninteractive",
    `${sudo}apt-get update -qq`,
    `${sudo}apt-get install -y -qq --no-install-recommends dbus-x11 novnc procps thunar websockify x11-utils x11vnc xdotool xfce4 xfce4-clipman xfce4-terminal xvfb`,
    `if ! (command -v google-chrome || command -v chromium || command -v chromium-browser) >/dev/null 2>&1; then ${sudo}apt-get install -y -qq --no-install-recommends chromium; fi`,
    `${sudo}rm -rf /var/lib/apt/lists/*`,
    probe,
  ].join("\n");
}

/** The name every renderer produces for these inputs; stable across providers. */
export function nativeImageName(inputs: Pick<NativeImageInputs, "claudeEnvironment">): string {
  const fingerprint = sha256(JSON.stringify({
    recipe: NATIVE_IMAGE_RECIPE_VERSION,
    runtime: NATIVE_RUNTIME_ARTIFACT.sourceCommit,
    runtimeArchive: NATIVE_RUNTIME_ARTIFACT.archiveSha256,
    runtimeDependencyLock: NATIVE_RUNTIME_ARTIFACT.dependencyLockSha256,
    bun: SANDBOX_BUN_VERSION,
    engines: RUNTIME_ENGINE_VERSIONS,
    claude: Object.keys(inputs.claudeEnvironment).length > 0,
    pi: PI_RUNTIME_LOCK_SHA256,
    documents: sha256(documentToolchainCommand({ home: "/root", workdir: "/root/work", runsAsRoot: true })),
    desktop: sha256(desktopToolchainCommand({ home: "/root", workdir: "/root/work", runsAsRoot: true })),
  })).slice(0, 10);
  return `useagent-native-${NATIVE_RUNTIME_ARTIFACT.sourceCommit.slice(0, 7)}-${fingerprint}`;
}

/** This deployment's native image name: the recipe inputs plus whether the Claude gateway is configured. */
export function deploymentNativeImageName(
  claudeEnvironment: Readonly<Record<string, string>> = claudeProviderGatewayEnvironment(),
): string {
  return nativeImageName({ claudeEnvironment });
}

/** True for names this recipe produced (any generation), so a stamped connection can be advanced. */
export function isNativeImageName(name: string | null | undefined): boolean {
  return /^useagent-native-[0-9a-f]{7}-[0-9a-f]{10}$/.test(name ?? "");
}

export function nativeImageSteps(layout: SandboxRuntimeLayout, inputs: NativeImageInputs): NativeImageStep[] {
  const home = layout.home;
  const bunStage = `${home}/.local/share/useagent/bun/.stage-image`;
  const runtimeStage = `${home}/.local/share/useagent/native-runtime/.stage-image`;
  const runtimeArchive = `${runtimeStage}/runtime.part-0`;
  const piRoot = layout.runsAsRoot ? PI_RUNTIME_ROOT : `${home}/.useagent/pi-runtime`;
  const piManifest = `${piRoot}/manifest`;
  const steps: NativeImageStep[] = [
    {
      name: "bun",
      files: [{ path: `${bunStage}/bun`, bytes: inputs.bun.bytes }],
      command: [
        `if ${buildSandboxBunProbeCommand(layout)}; then rm -rf ${q(bunStage)}; exit 0; fi`,
        buildSandboxBunInstallCommand(layout, `${bunStage}/bun`, inputs.bun.arch, sha256(inputs.bun.bytes)),
        `rm -rf ${q(bunStage)}`,
      ].join("\n"),
      timeoutSeconds: 300,
    },
    {
      name: "native-runtime",
      files: [
        { path: `${runtimeStage}/dependencies/bun.lock`, bytes: inputs.runtimeDependencyLock },
        { path: `${runtimeStage}/dependencies/package.json`, bytes: inputs.runtimeDependencyPackage },
        { path: runtimeArchive, bytes: inputs.runtimeArchive },
      ],
      command: [
        `if ${oneLine(buildNativeRuntimeArtifactProbe(layout))}; then rm -rf ${q(runtimeStage)}; exit 0; fi`,
        buildNativeRuntimeInstallCommand(layout, runtimeStage, [runtimeArchive]),
        `rm -rf ${q(runtimeStage)}`,
      ].join("\n"),
      timeoutSeconds: 600,
    },
    ...NATIVE_ENGINES.flatMap((engine): NativeImageStep[] => {
      if (engine === "claude" && Object.keys(inputs.claudeEnvironment).length === 0) return [];
      return [{
        name: engine,
        files: [],
        command: buildRuntimeProviderBootstrapCommand(engine, inputs.claudeEnvironment, layout),
        timeoutSeconds: 600,
      }];
    }),
    {
      name: "pi",
      files: [
        { path: `${piManifest}/package.json`, bytes: inputs.piPackage },
        { path: `${piManifest}/package-lock.json`, bytes: inputs.piLock },
      ],
      command: buildPiRuntimeEnsureCommand({
        runtimeRoot: piRoot,
        runtimeManifestDir: piManifest,
        bunExecutable: layout.bunExecutable ?? `${piRoot}/current/node_modules/.bin/bun`,
        executable: `${piRoot}/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`,
      }),
      timeoutSeconds: 600,
    },
    {
      name: "documents",
      files: [],
      command: documentToolchainCommand(layout),
      timeoutSeconds: 1500,
    },
    {
      name: "desktop",
      files: [],
      command: desktopToolchainCommand(layout),
      timeoutSeconds: 900,
    },
  ];
  return steps.map((step) => ({ ...step, command: `set -eu\nexport HOME=${q(home)}\n${step.command}` }));
}

export interface NativeImageTarget {
  readonly process: Pick<SandboxProcess, "executeCommand">;
  readonly fs: Pick<SandboxFileSystem, "uploadFile">;
}

/** Apply the recipe to a live sandbox; the caller freezes it afterwards. */
export async function applyNativeImage(
  target: NativeImageTarget,
  layout: SandboxRuntimeLayout,
  inputs: NativeImageInputs,
  options: { readonly signal: AbortSignal; readonly log?: (line: string) => void } ,
): Promise<void> {
  for (const step of nativeImageSteps(layout, inputs)) {
    options.signal.throwIfAborted();
    const startedAt = Date.now();
    for (const file of step.files) {
      const directory = file.path.slice(0, file.path.lastIndexOf("/"));
      const prepared = await target.process.executeCommand(`mkdir -p ${q(directory)}`, undefined, undefined, 30);
      if ((prepared.exitCode ?? 1) !== 0) throw new Error(`${step.name}: could not create ${directory}`);
      if (file.bytes.length <= UPLOAD_PART_BYTES) {
        await target.fs.uploadFile(file.bytes, file.path, 120);
        continue;
      }
      const parts: string[] = [];
      for (let offset = 0; offset < file.bytes.length; offset += UPLOAD_PART_BYTES) {
        options.signal.throwIfAborted();
        const part = `${file.path}.part-${parts.length}`;
        await target.fs.uploadFile(file.bytes.subarray(offset, offset + UPLOAD_PART_BYTES), part, 120);
        parts.push(part);
      }
      const joined = await target.process.executeCommand(
        `set -eu\ncat ${parts.map(q).join(" ")} > ${q(file.path)}\nrm -f ${parts.map(q).join(" ")}`,
        undefined,
        undefined,
        120,
      );
      if ((joined.exitCode ?? 1) !== 0) throw new Error(`${step.name}: could not assemble ${file.path}`);
    }
    const result = await target.process.executeCommand(step.command, undefined, undefined, step.timeoutSeconds);
    if ((result.exitCode ?? 1) !== 0) {
      throw new Error(`${step.name} failed (exit ${result.exitCode ?? "?"}): ${(result.result ?? "").trim().slice(-600)}`);
    }
    options.log?.(`${step.name} ready in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }
}

export interface NativeImageDockerfile {
  readonly dockerfile: string;
  /** Build-context files, relative to the context root. */
  readonly files: readonly { readonly contextPath: string; readonly bytes: Buffer }[];
}

/** The recipe as a Dockerfile on top of `baseImageArg` (a build ARG the caller supplies). Each step
 *  ships as a script file the Dockerfile copies and runs, so the classic builder (no heredocs) works. */
export function renderNativeImageDockerfile(
  layout: SandboxRuntimeLayout,
  inputs: NativeImageInputs,
  baseImageArg = "USEAGENT_NATIVE_BASE_IMAGE",
): NativeImageDockerfile {
  const files: { contextPath: string; bytes: Buffer }[] = [];
  const scripts = "/tmp/useagent-native-image";
  const lines = [
    `# ${nativeImageName(inputs)}: generated by backend/src/sandboxes/native-image.ts; do not edit.`,
    `ARG ${baseImageArg}`,
    `FROM \${${baseImageArg}}`,
    layout.runsAsRoot ? "USER root" : "",
    `ENV HOME=${layout.home} DEBIAN_FRONTEND=noninteractive`,
    `RUN mkdir -p ${layout.workdir}`,
  ];
  nativeImageSteps(layout, inputs).forEach((step, index) => {
    const context = `context/${index}-${step.name}`;
    const staged = `${scripts}/${index}-${step.name}`;
    // Files land in a staging area and the step copies them into place, so the
    // directories a step later renames were created in its own layer; a COPY'd
    // directory renamed on overlayfs (classic builder) becomes copy+delete and
    // pulls the working directory out from under the step's node processes.
    const placements = step.files.map((file) => {
      const name = file.path.slice(file.path.lastIndexOf("/") + 1);
      files.push({ contextPath: `${context}/${name}`, bytes: file.bytes });
      lines.push(`COPY ${context}/${name} ${staged}/${name}`);
      return `mkdir -p ${q(file.path.slice(0, file.path.lastIndexOf("/")))} && cp ${q(`${staged}/${name}`)} ${q(file.path)}`;
    });
    const script = `${staged}.sh`;
    files.push({
      contextPath: `${context}/step.sh`,
      bytes: Buffer.from(`set -eu\n${placements.join("\n")}${placements.length ? "\n" : ""}${step.command}\n`, "utf8"),
    });
    lines.push(`COPY ${context}/step.sh ${script}`, `RUN sh ${script} && rm -rf ${script} ${staged}`);
  });
  lines.push(`RUN rm -rf ${scripts}`, `LABEL org.useagent.native-image=${nativeImageName(inputs)}`);
  return { dockerfile: `${lines.filter((line) => line !== "").join("\n")}\n`, files };
}

function linuxArch(value: string): NativeImageInputs["bun"]["arch"] | null {
  if (value === "x64" || value === "x86_64" || value === "amd64") return "x64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  return null;
}

/** The inputs from the running backend: its own Bun binary and the packaged runtime assets. */
export async function loadNativeImageInputs(
  claudeEnvironment: Readonly<Record<string, string>>,
): Promise<NativeImageInputs> {
  if (process.platform !== "linux" || Bun.version !== SANDBOX_BUN_VERSION) {
    throw new Error(`the native image needs backend Bun ${SANDBOX_BUN_VERSION} on Linux (this is Bun ${Bun.version} on ${process.platform})`);
  }
  const arch = linuxArch(process.arch);
  if (!arch) throw new Error(`unsupported backend architecture ${process.arch}`);
  const asset = (path: string) => readFile(new URL(`../../${path}`, import.meta.url));
  const [bun, runtimeArchive, runtimeDependencyLock, runtimeDependencyPackage, piPackage, piLock] = await Promise.all([
    readFile(process.execPath),
    asset(`runtime-assets/${NATIVE_RUNTIME_ARTIFACT.archiveName}`),
    asset("runtime-assets/dependencies/bun.lock"),
    asset("runtime-assets/dependencies/package.json"),
    asset("pi-runtime/package.json"),
    asset("pi-runtime/package-lock.json"),
  ]);
  if (sha256(runtimeArchive) !== NATIVE_RUNTIME_ARTIFACT.archiveSha256) {
    throw new Error("the packaged native runtime failed its archive checksum");
  }
  if (sha256(runtimeDependencyLock) !== NATIVE_RUNTIME_ARTIFACT.dependencyLockSha256) {
    throw new Error("the packaged native runtime dependency lock failed its checksum");
  }
  if (sha256(piLock) !== PI_RUNTIME_LOCK_SHA256) {
    throw new Error("the packaged Pi runtime lock failed its checksum");
  }
  return {
    bun: { bytes: bun, arch },
    runtimeArchive,
    runtimeDependencyLock,
    runtimeDependencyPackage,
    piPackage,
    piLock,
    claudeEnvironment,
  };
}
