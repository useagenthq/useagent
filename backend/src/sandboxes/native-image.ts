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
import { sandboxRuntimeLayout, type SandboxRuntimeLayout } from "./provider";
import { SANDBOX_PROVIDER_KINDS } from "./plugins";
import {
  buildNativeRuntimeArtifactProbe,
  buildNativeRuntimeInstallCommand,
  NATIVE_RUNTIME_ARTIFACT,
} from "../engines/native-runtime-artifact";
import { buildRuntimeEnvironmentBootScript, desktopLaunchPath, runtimeEnvironmentBootPath } from "../engines/runtime-environment-boot";
import {
  buildPiRuntimeEnsureCommand,
  PI_RUNTIME_LOCK_SHA256,
  PI_RUNTIME_ROOT,
} from "../engines/pi-runtime-config";
import { buildRuntimeProviderBootstrapCommand } from "../engines/runtime-provider-bridge";
import {
  buildSandboxBunInstallCommand,
  buildSandboxBunProbeCommand,
  SANDBOX_BUN_VERSION,
} from "../engines/sandbox-bun";
import { claudeProviderGatewayEnvironment } from "../provider-gateway/sandbox-config";
import { BROWSER_LAUNCH_SCRIPT, desktopCdpRelaySource } from "../engines/desktop-cdp-relay";
import { SANDBOX_STATE_DIR } from "./sandbox-names";
import { buildDesktopLaunchScript, DESKTOP_REQUIRED_BINARIES } from "../engines/desktop-workstation";

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

const XORG_VIRTUAL_DISPLAY = `Section "Device"
    Identifier "Configured Video Device"
    Driver "dummy"
    VideoRam 256000
EndSection
Section "Monitor"
    Identifier "Configured Monitor"
    HorizSync 30.0-90.0
    VertRefresh 50.0-75.0
    Modeline "1920x1080_60.00" 173.00 1920 2048 2248 2576 1080 1083 1088 1120 -hsync +vsync
EndSection
Section "Screen"
    Identifier "Default Screen"
    Monitor "Configured Monitor"
    Device "Configured Video Device"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        Modes "1920x1080_60.00"
        Virtual 1920 1080
    EndSubSection
EndSection
`;

const PANEL = "11111111-1111-4111-8111-111111111111";
const APPLETS: readonly [string, string, "start" | "end", number][] = [
  ["a1111111-1111-4111-8111-111111111111", "Budgie Menu", "start", 0],
  ["a2111111-1111-4111-8111-111111111111", "Icon Task List", "start", 1],
  ["a3111111-1111-4111-8111-111111111111", "System Tray", "end", 0],
  ["a4111111-1111-4111-8111-111111111111", "Notifications", "end", 1],
  ["a5111111-1111-4111-8111-111111111111", "Status Indicator", "end", 2],
  ["a6111111-1111-4111-8111-111111111111", "Clock", "end", 3],
  ["a7111111-1111-4111-8111-111111111111", "Raven Trigger", "end", 4],
];

/** System-wide desktop defaults: dark Adwaita, Cantarell, one bottom panel, no lock or idle, desktop launchers. */
const DESKTOP_DEFAULTS = [
  "[org/gnome/desktop/interface]",
  "color-scheme='prefer-dark'",
  "gtk-theme='Adwaita'",
  "icon-theme='Adwaita'",
  "cursor-theme='Adwaita'",
  "font-name='Cantarell 11'",
  "document-font-name='Cantarell 11'",
  "monospace-font-name='Monospace 11'",
  "[org/gnome/desktop/wm/preferences]",
  "button-layout='appmenu:minimize,maximize,close'",
  "titlebar-font='Cantarell Bold 11'",
  "[org/gnome/desktop/background]",
  "picture-uri='file:///usr/share/backgrounds/gnome/adwaita-l.webp'",
  "picture-uri-dark='file:///usr/share/backgrounds/gnome/adwaita-d.webp'",
  "primary-color='#023c88'",
  "show-desktop-icons=false",
  "[org/gnome/desktop/screensaver]",
  "idle-activation-enabled=false",
  "lock-enabled=false",
  "[org/gnome/desktop/session]",
  "idle-delay=uint32 0",
  "[org/gnome/desktop/lockdown]",
  "disable-lock-screen=true",
  "[com/solus-project/budgie-panel]",
  "dark-theme=true",
  `panels=['${PANEL}']`,
  `[com/solus-project/budgie-panel/panels/{${PANEL}}]`,
  "location='bottom'",
  "size=36",
  "spacing=2",
  "enable-shadow=true",
  "transparency='none'",
  `applets=[${APPLETS.map(([id]) => `'${id}'`).join(", ")}]`,
  ...APPLETS.flatMap(([id, name, alignment, position]) => [
    `[com/solus-project/budgie-panel/applets/{${id}}]`,
    `name='${name}'`,
    `alignment='${alignment}'`,
    `position=${position}`,
  ]),
  "",
].join("\n");

/** The desktop icons and wallpaper are drawn by pcmanfm (it runs as root, which nemo refuses). */
const DESKTOP_ITEMS = [
  "[*]",
  "wallpaper_mode=crop",
  "wallpaper_common=1",
  "wallpaper=/usr/share/backgrounds/gnome/adwaita-l.webp",
  "desktop_bg=#023c88",
  "desktop_fg=#ffffff",
  "desktop_shadow=#000000",
  "desktop_font=Cantarell 11",
  "show_wm_menu=0",
  "sort=mtime;ascending;",
  "show_documents=0",
  "show_trash=0",
  "show_mounts=0",
  "",
].join("\n");

const DESKTOP_LAUNCHERS: readonly [string, string, string, string][] = [
  ["files", "Files", "pcmanfm %U", "system-file-manager"],
  // The desktop's own browser launch: its sandbox flags, its profile, and no background traffic.
  ["browser", "Browser", `sh -c "exec sh ${BROWSER_LAUNCH_SCRIPT}"`, "web-browser"],
  ["terminal", "Terminal", "gnome-terminal", "org.gnome.Terminal"],
];

/** Write `text` to `path` as the layout's privileged writer (heredoc, quoted delimiter). */
function writeFile(sudo: string, path: string, text: string, mode = "644"): string {
  return [
    `${sudo}install -d -m 755 ${q(path.slice(0, path.lastIndexOf("/")))}`,
    `${sudo}tee ${q(path)} >/dev/null <<'USEAGENT_EOF'`,
    text.replace(/\n$/, ""),
    "USEAGENT_EOF",
    `${sudo}chmod ${mode} ${q(path)}`,
  ].join("\n");
}

/** The desktop the sandbox shows: Budgie on a real Xorg dummy display at 1920x1080, dark Adwaita,
 *  desktop launchers drawn by nemo, x11vnc and noVNC for the stream. */
export function desktopToolchainCommand(layout: SandboxRuntimeLayout): string {
  const sudo = layout.runsAsRoot ? "" : "sudo -n ";
  const probe = desktopToolchainProbeCommand();
  const desktopDir = `${layout.home}/Desktop`;
  return [
    `chmod 0755 ${q(desktopLaunchPath(layout))}`,
    `if ${probe}; then exit 0; fi`,
    "export DEBIAN_FRONTEND=noninteractive",
    `${sudo}apt-get update -qq`,
    `${sudo}apt-get install -y -qq --no-install-recommends ` +
      "adwaita-icon-theme budgie-core dbus-x11 dconf-cli fonts-cantarell fonts-noto-mono gnome-backgrounds gnome-settings-daemon " +
      "gnome-terminal hicolor-icon-theme libglib2.0-bin librsvg2-common novnc pcmanfm procps webp-pixbuf-loader websockify x11-utils x11vnc xclip xdotool " +
      "xserver-xorg-core xserver-xorg-legacy xserver-xorg-video-dummy",
    `if ! (command -v google-chrome || command -v chromium || command -v chromium-browser) >/dev/null 2>&1; then ${sudo}apt-get install -y -qq --no-install-recommends chromium; fi`,
    `${sudo}rm -rf /var/lib/apt/lists/*`,
    writeFile(sudo, "/etc/X11/xorg.conf.d/10-virtual-display.conf", XORG_VIRTUAL_DISPLAY),
    // Xorg is started by whoever owns the desktop process session. On a non-root layout it must
    // run as that user: with root rights the server's shared-memory segments belong to root and
    // x11vnc (the user's process) dies on MIT-SHM BadAccess, so the stream never opens.
    writeFile(sudo, "/etc/X11/Xwrapper.config", `allowed_users=anybody\nneeds_root_rights=${layout.runsAsRoot ? "yes" : "no"}\n`),
    writeFile(sudo, "/etc/dconf/profile/user", "user-db:user\nsystem-db:local\n"),
    writeFile(sudo, "/etc/dconf/db/local.d/00-useagent-desktop", DESKTOP_DEFAULTS),
    `${sudo}dconf update`,
    // Symbolic icons are SVG; the caches make the themes visible to the panel.
    `${sudo}gtk-update-icon-cache -f -q /usr/share/icons/Adwaita || true`,
    `${sudo}gtk-update-icon-cache -f -q /usr/share/icons/hicolor || true`,
    writeFile("", `${layout.home}/.config/pcmanfm/useagent/desktop-items-0.conf`, DESKTOP_ITEMS),
    ...DESKTOP_LAUNCHERS.map(([file, name, exec, icon]) =>
      writeFile("", `${desktopDir}/${file}.desktop`, `[Desktop Entry]\nType=Application\nName=${name}\nExec=${exec}\nIcon=${icon}\n`, "755"),
    ),
    probe,
  ].join("\n");
}

/** The name every renderer produces for these inputs; stable across providers. It is a digest of
 *  everything the recipe writes and runs for each provider's layout, so no input can be left out. */
export function nativeImageName(
  inputs: NativeImageInputs,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return nativeImageNameOf(SANDBOX_PROVIDER_KINDS.map((kind) => nativeImageSteps(sandboxRuntimeLayout(kind), inputs, env)));
}

/** The name for these renderings: every step's name and command and every file's path and bytes. */
export function nativeImageNameOf(renderings: readonly (readonly NativeImageStep[])[]): string {
  const hashes = new Map<Buffer, string>();
  const fileHash = (bytes: Buffer) => hashes.get(bytes) ?? hashes.set(bytes, sha256(bytes)).get(bytes)!;
  const digests = renderings.map((steps) => sha256(JSON.stringify(
    steps.map((step) => [step.name, step.command, step.files.map((file) => [file.path, fileHash(file.bytes)])]),
  )));
  // Providers that share a layout render the same steps; a new one with a known layout changes nothing.
  const fingerprint = sha256([...new Set(digests)].toSorted().join("\n")).slice(0, 10);
  return `useagent-native-${NATIVE_RUNTIME_ARTIFACT.sourceCommit.slice(0, 7)}-${fingerprint}`;
}

/** This deployment's native image name: the recipe inputs plus whether the Claude gateway is configured. */
export async function deploymentNativeImageName(
  claudeEnvironment: Readonly<Record<string, string>> = claudeProviderGatewayEnvironment(),
): Promise<string> {
  return nativeImageName(await loadNativeImageInputs(claudeEnvironment));
}

/** True for names this recipe produced (any generation), so a stamped connection can be advanced. */
export function isNativeImageName(name: string | null | undefined): boolean {
  return /^useagent-native-[0-9a-f]{7}-[0-9a-f]{10}$/.test(name ?? "");
}

export function nativeImageSteps(
  layout: SandboxRuntimeLayout,
  inputs: NativeImageInputs,
  env: Readonly<Record<string, string | undefined>> = process.env,
): NativeImageStep[] {
  const home = layout.home;
  const bunStage = `${home}/.local/share/useagent/bun/.stage-image`;
  const runtimeParent = `${home}/.local/share/useagent/native-runtime`;
  const runtimeStage = `${runtimeParent}/.stage-image`;
  // Runtimes an older base image carried are dead weight in every sandbox: only the pinned one stays.
  const pruneOtherRuntimes = `find ${q(runtimeParent)} -mindepth 1 -maxdepth 1 ! -name ${q(NATIVE_RUNTIME_ARTIFACT.sourceCommit)} -exec rm -rf {} +`;
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
        `if ${oneLine(buildNativeRuntimeArtifactProbe(layout))}; then rm -rf ${q(runtimeStage)}; ${pruneOtherRuntimes}; exit 0; fi`,
        buildNativeRuntimeInstallCommand(layout, runtimeStage, [runtimeArchive]),
        `rm -rf ${q(runtimeStage)}`,
        pruneOtherRuntimes,
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
      name: "boot",
      files: [{ path: runtimeEnvironmentBootPath(layout), bytes: Buffer.from(buildRuntimeEnvironmentBootScript(env, layout), "utf8") }],
      command: `chmod 0755 ${q(runtimeEnvironmentBootPath(layout))}`,
      timeoutSeconds: 30,
    },
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
      files: [
        { path: desktopLaunchPath(layout), bytes: Buffer.from(buildDesktopLaunchScript(), "utf8") },
        { path: `${home}/${SANDBOX_STATE_DIR}/cdp-relay.mjs`, bytes: Buffer.from(desktopCdpRelaySource(), "utf8") },
      ],
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

/** The recipe as a Dockerfile on top of `baseImageArg` (a build ARG the caller supplies). The boot
 * script is the entrypoint and the base command is restated as CMD when the caller knows it. One COPY
 * stages the whole context and each step ships as a script file the Dockerfile runs, so the classic
 * builder (no heredocs) works and the image adds one layer per step. */
export function renderNativeImageDockerfile(
  layout: SandboxRuntimeLayout,
  inputs: NativeImageInputs,
  baseImageArg = "USEAGENT_NATIVE_BASE_IMAGE",
  env: Readonly<Record<string, string | undefined>> = process.env,
  /** The base image's own command; an ENTRYPOINT would otherwise drop it, and a provider's daemon may live in it. */
  baseCommand: readonly string[] = [],
): NativeImageDockerfile {
  const files: { contextPath: string; bytes: Buffer }[] = [];
  const scripts = "/tmp/useagent-native-image";
  // Files land in a staging area and the step copies them into place, so the
  // directories a step later renames were created in its own layer; a COPY'd
  // directory renamed on overlayfs (classic builder) becomes copy+delete and
  // pulls the working directory out from under the step's node processes.
  // The whole context is staged by one COPY: a layer per file and per script
  // on top of a base that already carries over a hundred layers overran the
  // runtime's layer depth limit ("failed to register layer: max depth exceeded").
  // A non-root layout runs its steps as the runtime user, who must own what
  // COPY staged so the step can read and remove it.
  const copy = layout.runsAsRoot ? "COPY" : "COPY --chown=1000:1000";
  const imageName = nativeImageName(inputs, env);
  const lines = [
    `# ${imageName}: generated by backend/src/sandboxes/native-image.ts; do not edit.`,
    `ARG ${baseImageArg}`,
    `FROM \${${baseImageArg}}`,
    layout.runsAsRoot ? "USER root" : "",
    `ENV HOME=${layout.home} DEBIAN_FRONTEND=noninteractive`,
    `RUN mkdir -p ${layout.workdir}`,
    `${copy} context/ ${scripts}/`,
  ];
  nativeImageSteps(layout, inputs, env).forEach((step, index) => {
    const context = `context/${index}-${step.name}`;
    const staged = `${scripts}/${index}-${step.name}`;
    const placements = step.files.map((file) => {
      const name = file.path.slice(file.path.lastIndexOf("/") + 1);
      files.push({ contextPath: `${context}/${name}`, bytes: file.bytes });
      return `mkdir -p ${q(file.path.slice(0, file.path.lastIndexOf("/")))} && cp ${q(`${staged}/${name}`)} ${q(file.path)}`;
    });
    const script = `${staged}.sh`;
    files.push({
      contextPath: `${context}.sh`,
      bytes: Buffer.from(`set -eu\n${placements.join("\n")}${placements.length ? "\n" : ""}${step.command}\n`, "utf8"),
    });
    lines.push(`RUN sh ${script} && rm -rf ${script} ${staged}`);
  });
  lines.push(
    `RUN rm -rf ${scripts}`,
    `LABEL org.useagent.native-image=${imageName}`,
    // A sandbox comes up with its runtime ready; providers that ignore the image entrypoint still work, the plane repairs.
    `ENTRYPOINT [${JSON.stringify(runtimeEnvironmentBootPath(layout))}]`,
    ...(baseCommand.length ? [`CMD ${JSON.stringify(baseCommand)}`] : []),
  );
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
