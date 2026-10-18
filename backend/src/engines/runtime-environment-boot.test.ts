import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopReadinessCommand } from "./desktop-workstation";
import { buildRuntimeEnvironmentBootScript, desktopLaunchPath, runtimeEnvironmentBootPath } from "./runtime-environment-boot";
import { buildRuntimeEnvironmentAuthenticationCommand } from "./runtime-environment-client";
import { buildRuntimeEnvironmentLaunchCommand, buildRuntimeEnvironmentReadinessCommand } from "./runtime-environment";
import { sandboxRuntimeLayout } from "../sandboxes/provider";
import { SANDBOX_STATE_DIR, SANDBOX_STATE_HOME } from "../sandboxes/sandbox-names";

describe("sandbox boot entrypoint", () => {
  const env = {};
  const script = buildRuntimeEnvironmentBootScript(env);

  test("starts the plane's exact launch command in the background, waits on the plane's readiness probe, pairs, warms the shell and keeps the container alive", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    const single = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    expect(script).toContain(`nohup sh -c ${single(buildRuntimeEnvironmentLaunchCommand(env))} >"/root/${SANDBOX_STATE_DIR}/t3/boot.log" 2>&1 &`);
    expect(script).toContain(`until sh -c ${single(buildRuntimeEnvironmentReadinessCommand())}; do`);
    expect(script).toContain(`sh -c ${single(buildRuntimeEnvironmentAuthenticationCommand())} >>"/root/${SANDBOX_STATE_DIR}/t3/boot.log" 2>&1 || true`);
    expect(script).toContain("http://127.0.0.1:37733/api/orchestration/shell || true");
    expect(script.trimEnd().endsWith('[ "$#" -gt 0 ] && exec "$@"\nexec sleep infinity')).toBe(true);
    // The whole boot runs in a background subshell; the main process is the sandbox's own command from the start.
    expect(script.indexOf(`) >>"/root/${SANDBOX_STATE_DIR}/t3/boot.log" 2>&1 &`)).toBeLessThan(script.indexOf('[ "$#" -gt 0 ] && exec "$@"'));
    expect(script.indexOf("nohup sh -c")).toBeGreaterThan(script.indexOf("\n(\n"));
    expect(Bun.spawnSync(["sh", "-n"], { stdin: Buffer.from(script) }).exitCode).toBe(0);
    // The plane sees the boot in progress from the moment before the launch until readiness passed or the wait gave up.
    expect(script.indexOf(`touch "${SANDBOX_STATE_HOME}/t3/.useagent-runtime-booting"`)).toBeLessThan(script.indexOf("nohup sh -c"));
    expect(script.indexOf(`rm -f "${SANDBOX_STATE_HOME}/t3/.useagent-runtime-booting"`)).toBeGreaterThan(script.indexOf("done\n"));
    // The wait is bounded: a runtime that never comes up leaves the sandbox idle for the plane to repair.
    expect(script).toContain('[ "$i" -ge 600 ] && break');
  });

  test("the baked boot starts the runtime with the plane's flags", () => {
    expect(script).toContain(`"mcp=off,continuations=off,instructions=off,telemetry=off" > "/root/${SANDBOX_STATE_DIR}/t3/.useagent-runtime-flags"`);
    // The baked boot starts the runtime with third-party telemetry off.
    expect(script).toContain("export T3CODE_TELEMETRY_ENABLED=false");
  });

  test("boots the desktop after the runtime is warm and marks the boot for the plane", () => {
    const single = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    expect(script).toContain(`[ -s "/root/${SANDBOX_STATE_DIR}/cdp-relay.token" ] || { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n' >"/root/${SANDBOX_STATE_DIR}/cdp-relay.token"; chmod 600 "/root/${SANDBOX_STATE_DIR}/cdp-relay.token"; }`);
    expect(script).toContain(`rm -f "/root/${SANDBOX_STATE_DIR}/desktop.pid"\ntouch "/root/${SANDBOX_STATE_DIR}/desktop-boot"`);
    expect(script).toContain(`setsid "/root/.local/bin/useagent-desktop-launch" >"/root/${SANDBOX_STATE_DIR}/desktop-launch.log" 2>&1 </dev/null &`);
    expect(script).toContain('kill -0 "$desktop" 2>/dev/null || break');
    expect(script).toContain(`echo "$desktop" >"/root/${SANDBOX_STATE_DIR}/desktop.pid"`);
    expect(script).toContain(`until sh -c ${single(buildDesktopReadinessCommand())}; do`);
    expect(script).toContain(`rm -f "/root/${SANDBOX_STATE_DIR}/desktop-boot"`);
    expect(script.indexOf("useagent-desktop-launch")).toBeGreaterThan(script.indexOf("/api/orchestration/shell || true"));
    expect(desktopLaunchPath()).toBe("/root/.local/bin/useagent-desktop-launch");
  });

  test("a non-root layout boots from its own home", () => {
    const layout = { home: "/home/user", workdir: "/home/user/work", runsAsRoot: false };
    expect(runtimeEnvironmentBootPath(layout)).toBe("/home/user/.local/bin/useagent-sandbox-boot");
    const local = buildRuntimeEnvironmentBootScript({}, layout);
    expect(local).toContain('export HOME="/home/user"');
    expect(local).toContain(`>"/home/user/${SANDBOX_STATE_DIR}/t3/boot.log"`);
    expect(local).not.toContain("/root/");
  });

  test("restores the image's Bun to 755 before the runtime starts, so the plane's probe passes without an upload", async () => {
    const cube = buildRuntimeEnvironmentBootScript({}, sandboxRuntimeLayout("cube"));
    const line = '[ -f "/usr/local/bin/bun" ] && chmod 755 "/usr/local/bin/bun" 2>/dev/null || true';
    expect(cube).toContain(line);
    expect(cube.indexOf(line)).toBeLessThan(cube.indexOf("nohup sh -c"));
    const directory = await mkdtemp(join(tmpdir(), "useagent-boot-bun-"));
    try {
      const bun = join(directory, "bun");
      await Bun.write(bun, "#!/bin/sh\n");
      await chmod(bun, 0o777);
      const script = buildRuntimeEnvironmentBootScript({}, { home: directory, workdir: join(directory, "work"), runsAsRoot: false, bunExecutable: bun });
      const chmodLine = script.split("\n").find((candidate) => candidate.includes("chmod 755"))!;
      expect(Bun.spawnSync(["sh", "-c", chmodLine]).exitCode).toBe(0);
      expect((await stat(bun)).mode & 0o777).toBe(0o755);
      // A layout whose Bun is missing boots on.
      await rm(bun);
      expect(Bun.spawnSync(["sh", "-c", chmodLine]).exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
