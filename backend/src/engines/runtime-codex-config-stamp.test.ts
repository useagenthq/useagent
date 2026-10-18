import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle } from "../sandboxes/provider";
import { readCodexConfigChange, stampCodexConfig } from "./runtime-codex-config-stamp";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

/** A sandbox whose commands run on this machine in a scratch HOME. */
function scratchSandbox() {
  const home = mkdtempSync(join(tmpdir(), "codex-config-stamp-"));
  homes.push(home);
  mkdirSync(join(home, ".codex"));
  const sandbox = {
    process: {
      async executeCommand(command: string) {
        const run = Bun.spawnSync(["sh", "-c", command], { env: { ...process.env, HOME: home } });
        return { exitCode: run.exitCode, result: run.stdout.toString() };
      },
    },
  } as unknown as Pick<SandboxHandle, "process">;
  const writeConfig = (bearer: string) => writeFileSync(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.tools]\nhttp_headers = { Authorization = "Bearer ${bearer}" }\n`,
  );
  return { sandbox, writeConfig };
}

describe("Codex config stamp", () => {
  test("a thread's session counts as stale only once the config changed after it started", async () => {
    const { sandbox, writeConfig } = scratchSandbox();
    writeConfig("one");
    // A thread never stamped may hold a session of any config.
    const first = await readCodexConfigChange(sandbox, `${SANDBOX_NAME_PREFIX}-thread-1`);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await stampCodexConfig(sandbox, `${SANDBOX_NAME_PREFIX}-thread-1`, first!);
    expect(await readCodexConfigChange(sandbox, `${SANDBOX_NAME_PREFIX}-thread-1`)).toBeNull();

    // A rotated bearer is a change until the thread's session restarted on it.
    writeConfig("two");
    const revision = await readCodexConfigChange(sandbox, `${SANDBOX_NAME_PREFIX}-thread-1`);
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    expect(revision).not.toBe(first);
    expect(await readCodexConfigChange(sandbox, `${SANDBOX_NAME_PREFIX}-thread-1`)).toBe(revision);
    await stampCodexConfig(sandbox, `${SANDBOX_NAME_PREFIX}-thread-1`, revision!);
    expect(await readCodexConfigChange(sandbox, `${SANDBOX_NAME_PREFIX}-thread-1`)).toBeNull();

    // Every thread has its own stamp.
    expect(await readCodexConfigChange(sandbox, `${SANDBOX_NAME_PREFIX}-thread-2`)).toBe(revision);
  });
});
