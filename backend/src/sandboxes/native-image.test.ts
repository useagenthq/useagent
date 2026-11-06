import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyNativeImage,
  desktopToolchainCommand,
  isNativeImageName,
  nativeImageName,
  nativeImageNameOf,
  nativeImageSteps,
  renderNativeImageDockerfile,
  type NativeImageInputs,
  type NativeImageStep,
} from "./native-image";
import { NATIVE_RUNTIME_ARTIFACT } from "../engines/native-runtime-artifact";
import { SANDBOX_PROVIDER_KINDS } from "./plugins";
import { sandboxRuntimeLayout, type SandboxRuntimeLayout } from "./provider";
import { SANDBOX_STATE_DIR, SANDBOX_STATE_HOME } from "./sandbox-names";

const BOX_LAYOUT: SandboxRuntimeLayout = {
  home: "/home/user",
  workdir: "/home/user/work",
  bunExecutable: "/usr/local/bin/bun",
  runsAsRoot: false,
};
const CUBE_LAYOUT: SandboxRuntimeLayout = {
  home: "/root",
  workdir: "/root/work",
  bunExecutable: "/usr/local/bin/bun",
  runsAsRoot: true,
};

function inputs(overrides: Partial<NativeImageInputs> = {}): NativeImageInputs {
  return {
    bun: { bytes: Buffer.from("bun-binary"), arch: "x64" },
    runtimeArchive: Buffer.from("archive"),
    runtimeDependencyLock: Buffer.from("lock"),
    runtimeDependencyPackage: Buffer.from("{}"),
    piPackage: Buffer.from("{}"),
    piLock: Buffer.from("{}"),
    claudeEnvironment: { ANTHROPIC_BASE_URL: "https://gateway.example/anthropic", CLAUDE_CONFIG_DIR: "/home/user/.useagent/claude" },
    ...overrides,
  };
}

describe("native image name", () => {
  test("is a fingerprint of the inputs and recognisable as ours", () => {
    const name = nativeImageName(inputs());
    expect(name).toMatch(/^useagent-native-[0-9a-f]{7}-[0-9a-f]{10}$/);
    expect(isNativeImageName(name)).toBe(true);
    expect(nativeImageName(inputs())).toBe(name);
    expect(nativeImageName(inputs({ claudeEnvironment: {} }))).not.toBe(name);
  });

  test("covers every step's command and every file's bytes, for every provider layout", () => {
    const renderings = [nativeImageSteps(CUBE_LAYOUT, inputs()), nativeImageSteps(BOX_LAYOUT, inputs())];
    const name = nativeImageNameOf(renderings);
    expect(nativeImageNameOf([nativeImageSteps(CUBE_LAYOUT, inputs()), nativeImageSteps(BOX_LAYOUT, inputs())])).toBe(name);
    const changed = (r: number, s: number, change: (step: NativeImageStep) => NativeImageStep) =>
      nativeImageNameOf(renderings.with(r, renderings[r]!.with(s, change(renderings[r]![s]!))));
    let files = 0;
    renderings.forEach((steps, r) => steps.forEach((step, s) => {
      expect(changed(r, s, (it) => ({ ...it, command: `${it.command}\n` }))).not.toBe(name);
      step.files.forEach((file, f) => {
        files++;
        const bytes = Buffer.concat([file.bytes, Buffer.from(" ")]);
        expect(changed(r, s, (it) => ({ ...it, files: it.files.with(f, { ...file, bytes }) }))).not.toBe(name);
      });
    }));
    // The desktop launcher and relay are among them (a launcher-only change once kept its name).
    expect(renderings[0]!.find((step) => step.name === "desktop")!.files).toHaveLength(2);
    expect(files).toBeGreaterThan(10);
  });

  test("is the name of this deployment's renderings for every provider kind", () => {
    const layouts = SANDBOX_PROVIDER_KINDS.map((kind) => nativeImageSteps(sandboxRuntimeLayout(kind), inputs()));
    expect(nativeImageName(inputs())).toBe(nativeImageNameOf(layouts));
  });

  test("rejects other snapshot names", () => {
    expect(isNativeImageName("useagent-opencode-1-18-7")).toBe(false);
    expect(isNativeImageName("")).toBe(false);
    expect(isNativeImageName(null)).toBe(false);
  });
});

describe("native image steps", () => {
  test("the runtime step keeps only the pinned runtime, whichever way it ends", async () => {
    const home = await mkdtemp(join(tmpdir(), "useagent-runtime-prune-"));
    try {
      const command = nativeImageSteps(CUBE_LAYOUT, inputs()).find((step) => step.name === "native-runtime")!.command;
      const prune = command.split("\n").at(-1)!;
      expect(prune).toContain(`! -name '${NATIVE_RUNTIME_ARTIFACT.sourceCommit}'`);
      // The early exit (runtime already in the base image) prunes too.
      expect(command.split("\n").find((line) => line.startsWith("if "))).toContain(`${prune}; exit 0; fi`);
      const parent = join(home, ".local/share/useagent/native-runtime");
      for (const dir of [NATIVE_RUNTIME_ARTIFACT.sourceCommit, "524d46b26f5ac85c82cd41e20f6c709d9f08db9b", "90dc3ebbb74b0e85f41c4cb3105a9f8994ce0bfa", ".stage-old"]) {
        await Bun.write(join(parent, dir, "bin/t3"), "#!/bin/sh\n");
      }
      // Run against a scratch copy of the layout's runtime parent.
      expect(Bun.spawnSync(["sh", "-c", prune.replace("/root/.local/share/useagent/native-runtime", parent)]).exitCode).toBe(0);
      expect(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: parent, onlyFiles: false, dot: true }))).toEqual([
        NATIVE_RUNTIME_ARTIFACT.sourceCommit,
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("the desktop step's configuration survives the shell round trip", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-desktop-"));
    const home = join(root, "home");
    const command = desktopToolchainCommand({ home, workdir: `${home}/work`, runsAsRoot: true });
    // Only the writes run: package installs and the probe are stubbed, /etc is redirected under the temp root.
    const child = Bun.spawn(["bash", "-c", `
command() { return 1; }
test() { return 1; }
apt-get() { :; }
rm() { :; }
dconf() { :; }
gtk-update-icon-cache() { :; }
install() { shift; shift; shift; mkdir -p "${root}$1"; }
tee() { cat > "${root}$1"; }
chmod() { :; }
set -u
${command.replace(/\nif .*; then exit 0; fi\n/, "\n").split("\n").filter((line) => !line.startsWith("command -v")).join("\n")}
`], { stdout: "pipe", stderr: "pipe" });
    await child.exited;
    expect(await Bun.file(join(root, "etc/X11/xorg.conf.d/10-virtual-display.conf")).text()).toContain('Modeline "1920x1080_60.00"');
    const defaults = await Bun.file(join(root, "etc/dconf/db/local.d/00-useagent-desktop")).text();
    expect(defaults).toContain("[com/solus-project/budgie-panel]");
    expect(defaults).toContain("name='Raven Trigger'");
    expect(defaults).toContain("picture-uri='file:///usr/share/backgrounds/gnome/adwaita-l.webp'");
    expect(await Bun.file(join(root, `${home}/.config/pcmanfm/useagent/desktop-items-0.conf`)).text()).toContain("wallpaper=/usr/share/backgrounds/gnome/adwaita-l.webp");
    const browser = await Bun.file(join(root, `${home}/Desktop/browser.desktop`)).text();
    // The icon runs the desktop's own browser launch: its sandbox flags, profile and background-traffic lockdown.
    expect(browser).toContain(`Exec=sh -c "exec sh ${SANDBOX_STATE_HOME}/browser-launch.sh"`);
    expect(await Bun.file(join(root, `${home}/Desktop/files.desktop`)).text()).toContain("Exec=pcmanfm %U");
    await rm(root, { recursive: true, force: true });
  });

  test("repairs missing desktop tools and refuses an incomplete installation", async () => {
    for (const repaired of [true, false]) {
      const child = Bun.spawn(["bash", "-c", `
installed=0
command() {
  case "$2" in
    xdotool|pcmanfm) [ "$installed" = 1 ] ;;
    *) return 0 ;;
  esac
}
test() { [ "$1" = -r ] && [ "$2" = /usr/share/novnc/vnc.html ]; }
apt-get() {
  case " $* " in
    *" install "*)
      case " $* " in *" xdotool "*) ;; *) return 1 ;; esac
      case " $* " in *" budgie-core "*) ;; *) return 1 ;; esac
      case " $* " in *" xserver-xorg-video-dummy "*) ;; *) return 1 ;; esac
      echo installed-desktop-tools
      installed=${repaired ? 1 : 0}
      ;;
  esac
}
rm() { :; }
install() { :; }
tee() { cat >/dev/null; }
chmod() { :; }
dconf() { :; }
gtk-update-icon-cache() { :; }
set -eu
${desktopToolchainCommand(CUBE_LAYOUT)}
`], { stdout: "pipe", stderr: "pipe" });
      const [output, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(stderr).toBe("");
      expect(output).toContain("installed-desktop-tools");
      expect(exitCode === 0).toBe(repaired);
    }
  });

  test("cover bun, the runtime, every driver, Pi, documents and desktop in order", () => {
    const steps = nativeImageSteps(BOX_LAYOUT, inputs());
    expect(steps.map((step) => step.name)).toEqual([
      "bun", "native-runtime", "codex", "claude", "opencode", "boot", "pi", "documents", "desktop",
    ]);
    for (const step of steps) {
      expect(step.command.startsWith("set -eu\nexport HOME='/home/user'\n")).toBe(true);
    }
  });

  test("skip the Claude driver when no provider gateway is configured", () => {
    const steps = nativeImageSteps(BOX_LAYOUT, inputs({ claudeEnvironment: {} }));
    expect(steps.map((step) => step.name)).not.toContain("claude");
  });

  test("place files under the layout's home and probe before installing", () => {
    const steps = nativeImageSteps(BOX_LAYOUT, inputs());
    const runtime = steps.find((step) => step.name === "native-runtime")!;
    expect(runtime.files.map((file) => file.path)).toEqual([
      "/home/user/.local/share/useagent/native-runtime/.stage-image/dependencies/bun.lock",
      "/home/user/.local/share/useagent/native-runtime/.stage-image/dependencies/package.json",
      "/home/user/.local/share/useagent/native-runtime/.stage-image/runtime.part-0",
    ]);
    const condition = runtime.command.split("\n").find((line) => line.startsWith("if "))!;
    expect(condition).not.toContain("#");
    expect(condition).toContain("exit 0; fi");
    const pi = steps.find((step) => step.name === "pi")!;
    expect(pi.files.map((file) => file.path)).toEqual([
      "/home/user/.useagent/pi-runtime/manifest/package.json",
      "/home/user/.useagent/pi-runtime/manifest/package-lock.json",
    ]);
    expect(pi.command).toContain("/usr/local/bin/bun");
    const desktop = steps.find((step) => step.name === "desktop")!;
    expect(desktop.files.map((file) => file.path)).toEqual([
      "/home/user/.local/bin/useagent-desktop-launch",
      `/home/user/${SANDBOX_STATE_DIR}/cdp-relay.mjs`,
    ]);
    expect(desktop.files[0]!.bytes.toString("utf8")).toContain("#!/bin/sh\n");
    expect(desktop.files[0]!.bytes.toString("utf8")).toContain("Xorg :1 -noreset -nolisten tcp -ac");
    expect(desktop.command).toContain("chmod 0755 '/home/user/.local/bin/useagent-desktop-launch'");
  });

  test("use sudo for the document toolchain only when the sandbox runs unprivileged", () => {
    const box = nativeImageSteps(BOX_LAYOUT, inputs()).find((step) => step.name === "documents")!;
    const cube = nativeImageSteps(CUBE_LAYOUT, inputs()).find((step) => step.name === "documents")!;
    expect(box.command).toContain("sudo -n apt-get install");
    expect(cube.command).toContain("\napt-get install");
    expect(cube.command).not.toContain("sudo");
    const piOnCube = nativeImageSteps(CUBE_LAYOUT, inputs()).find((step) => step.name === "pi")!;
    expect(piOnCube.files[0]!.path).toBe("/opt/useagent/pi-runtime/manifest/package.json");
  });

  test("let the desktop user start Xorg without root rights when the sandbox runs unprivileged", () => {
    // With root rights the server's shared-memory segments belong to root and the user's x11vnc
    // dies on MIT-SHM BadAccess, so the stream never opens (proved on the local image).
    const box = nativeImageSteps(BOX_LAYOUT, inputs()).find((step) => step.name === "desktop")!;
    const cube = nativeImageSteps(CUBE_LAYOUT, inputs()).find((step) => step.name === "desktop")!;
    expect(box.command).toContain("allowed_users=anybody\nneeds_root_rights=no\n");
    expect(cube.command).toContain("allowed_users=anybody\nneeds_root_rights=yes\n");
  });
});

describe("native image Dockerfile", () => {
  test("stages the context with one COPY and runs every step from the base image argument", () => {
    const rendered = renderNativeImageDockerfile(CUBE_LAYOUT, inputs());
    expect(rendered.dockerfile.startsWith(`# ${nativeImageName(inputs())}`)).toBe(true);
    expect(rendered.dockerfile).toContain("ARG USEAGENT_NATIVE_BASE_IMAGE\nFROM ${USEAGENT_NATIVE_BASE_IMAGE}\nUSER root\n");
    expect(rendered.dockerfile).toContain("RUN mkdir -p /root/work\nCOPY context/ /tmp/useagent-native-image/\n");
    expect(rendered.files.map((file) => file.contextPath)).toEqual([
      "context/0-bun/bun",
      "context/0-bun.sh",
      "context/1-native-runtime/bun.lock",
      "context/1-native-runtime/package.json",
      "context/1-native-runtime/runtime.part-0",
      "context/1-native-runtime.sh",
      "context/2-codex.sh",
      "context/3-claude.sh",
      "context/4-opencode.sh",
      "context/5-boot/useagent-sandbox-boot",
      "context/5-boot.sh",
      "context/6-pi/package.json",
      "context/6-pi/package-lock.json",
      "context/6-pi.sh",
      "context/7-documents.sh",
      "context/8-desktop/useagent-desktop-launch",
      "context/8-desktop/cdp-relay.mjs",
      "context/8-desktop.sh",
    ]);
    // Every layer on top of the base: the workdir, the staged context, one RUN per step, the cleanup.
    // The base image already carries over a hundred layers; the runtime rejects images past its depth limit.
    const steps = nativeImageSteps(CUBE_LAYOUT, inputs());
    const layers = rendered.dockerfile.split("\n").filter((line) => /^(COPY|RUN)\b/.test(line));
    expect(layers.filter((line) => line.startsWith("COPY"))).toEqual(["COPY context/ /tmp/useagent-native-image/"]);
    expect(layers.filter((line) => line.startsWith("RUN sh "))).toEqual(steps.map((step, index) =>
      `RUN sh /tmp/useagent-native-image/${index}-${step.name}.sh && rm -rf /tmp/useagent-native-image/${index}-${step.name}.sh /tmp/useagent-native-image/${index}-${step.name}`,
    ));
    expect(layers).toHaveLength(steps.length + 3);
    expect(layers.at(-1)).toBe("RUN rm -rf /tmp/useagent-native-image");
    expect(rendered.dockerfile).not.toContain("<<");
    // The image boots its runtime: the entrypoint is the installed boot script.
    expect(rendered.dockerfile.trimEnd().endsWith('ENTRYPOINT ["/root/.local/bin/useagent-sandbox-boot"]')).toBe(true);
    // The base image's command survives the entrypoint when the bake knows it; a provider daemon may live there.
    const withCommand = renderNativeImageDockerfile(CUBE_LAYOUT, inputs(), undefined, process.env, ["/usr/local/bin/start-sandbox.sh"]);
    expect(withCommand.dockerfile.trimEnd().endsWith('ENTRYPOINT ["/root/.local/bin/useagent-sandbox-boot"]\nCMD ["/usr/local/bin/start-sandbox.sh"]')).toBe(true);
    const boot = rendered.files.find((file) => file.contextPath === "context/5-boot/useagent-sandbox-boot")!;
    expect(boot.bytes.toString("utf8").startsWith("#!/bin/sh\n")).toBe(true);
    const bun = rendered.files.find((file) => file.contextPath === "context/0-bun.sh")!;
    expect(bun.bytes.toString("utf8").startsWith(
      "set -eu\nmkdir -p '/root/.local/share/useagent/bun/.stage-image' && cp '/tmp/useagent-native-image/0-bun/bun' '/root/.local/share/useagent/bun/.stage-image/bun'\nset -eu\nexport HOME='/root'\n",
    )).toBe(true);
    const documents = rendered.files.find((file) => file.contextPath === "context/7-documents.sh")!;
    expect(documents.bytes.toString("utf8").startsWith("set -eu\nset -eu\nexport HOME='/root'\n")).toBe(true);
    expect(rendered.dockerfile).toContain(`LABEL org.useagent.native-image=${nativeImageName(inputs())}\n`);
  });

  test("hands the staged context to the runtime user when the sandbox runs unprivileged", () => {
    const rendered = renderNativeImageDockerfile(BOX_LAYOUT, inputs());
    expect(rendered.dockerfile).toContain("\nCOPY --chown=1000:1000 context/ /tmp/useagent-native-image/\n");
    expect(rendered.dockerfile).not.toContain("USER root");
  });
});

describe("applying the native image to a live sandbox", () => {
  function fakeTarget(exitCodes: Record<string, number> = {}) {
    const uploads: { path: string; bytes: number }[] = [];
    const commands: string[] = [];
    return {
      uploads,
      commands,
      target: {
        process: {
          async executeCommand(command: string) {
            commands.push(command);
            const step = Object.keys(exitCodes).find((name) => command.includes(`${name} `) || command.includes(name));
            return { exitCode: step ? exitCodes[step]! : 0, result: "" };
          },
        },
        fs: {
          async uploadFile(bytes: Buffer, path: string) {
            uploads.push({ path, bytes: bytes.length });
          },
        },
      },
    };
  }

  test("uploads each step's files, splitting large ones into parts, then runs the step", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 5, 1);
    const fake = fakeTarget();
    await applyNativeImage(fake.target, BOX_LAYOUT, inputs({ bun: { bytes: big, arch: "x64" } }), {
      signal: new AbortController().signal,
    });
    const bunUploads = fake.uploads.filter((upload) => upload.path.includes("/bun/.stage-image/bun"));
    expect(bunUploads.map((upload) => upload.path.slice(upload.path.lastIndexOf("/") + 1))).toEqual(["bun.part-0", "bun.part-1"]);
    expect(bunUploads.map((upload) => upload.bytes)).toEqual([3 * 1024 * 1024, 5]);
    expect(fake.commands.some((command) => command.includes("cat ") && command.includes("bun.part-0") && command.includes("bun.part-1"))).toBe(true);
    const stepCommands = fake.commands.filter((command) => command.startsWith("set -eu\nexport HOME="));
    expect(stepCommands).toHaveLength(9);
    expect(fake.uploads.at(-1)!.path).toBe(`/home/user/${SANDBOX_STATE_DIR}/cdp-relay.mjs`);
  });

  test("names the failing step", async () => {
    const fake = fakeTarget({ "apt-get": 100 });
    await expect(
      applyNativeImage(fake.target, BOX_LAYOUT, inputs(), { signal: new AbortController().signal }),
    ).rejects.toThrow(/^documents failed \(exit 100\)/);
  });
});
