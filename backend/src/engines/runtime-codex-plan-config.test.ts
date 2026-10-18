import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  applyPendingCodexProviderConfiguration,
  buildAcknowledgeCodexProviderConfigurationCommand,
  buildPendingCodexProviderConfigurationProbeCommand,
} from "./runtime-codex-plan-config";
import { SANDBOX_STATE_DIR } from "../sandboxes/sandbox-names";

const revisionA = "a".repeat(64);
const revisionB = "b".repeat(64);

describe("Codex provider configuration fence", () => {
  test("restarts and acknowledges once without touching retained state", async () => {
    const calls: string[] = [];
    const retained = { workspace: ["existing.ts"], resumeCursor: { threadId: "native-thread-1" } };
    const sandboxState = {
      id: "warm-codex",
      retained,
      process: {
        async executeCommand(command: string) {
          expect(command).toContain(revisionA);
          calls.push("ack");
          return { exitCode: 0, result: "" };
        },
      },
    };
    const sandbox = sandboxState as unknown as SandboxHandle;

    await expect(
      applyPendingCodexProviderConfiguration({
        sandbox,
        signal: new AbortController().signal,
        revision: revisionA,
        dependencies: {
          restart: async (restarted) => {
            expect(restarted).toBe(sandbox);
            expect(sandboxState.retained).toEqual(retained);
            calls.push("restart");
            return {} as never;
          },
          invalidateAccess: (invalidated) => {
            expect(invalidated).toBe(sandbox);
            calls.push("invalidate");
          },
        },
      }),
    ).resolves.toBe(true);

    expect(calls).toEqual(["restart", "invalidate", "ack"]);
    expect(sandboxState.retained).toEqual(retained);
  });

  test("does nothing without a pending revision", async () => {
    let remoteCalls = 0;
    await expect(
      applyPendingCodexProviderConfiguration({
        sandbox: { process: { executeCommand: async () => ({ exitCode: 0 }) } } as never,
        signal: new AbortController().signal,
        revision: null,
        dependencies: {
          restart: async () => {
            remoteCalls += 1;
            return {} as never;
          },
          invalidateAccess: () => {
            remoteCalls += 1;
          },
        },
      }),
    ).resolves.toBe(false);
    expect(remoteCalls).toBe(0);
  });

  test("keeps the durable intent when restart fails", async () => {
    let acknowledgements = 0;
    await expect(
      applyPendingCodexProviderConfiguration({
        sandbox: {
          process: {
            executeCommand: async () => {
              acknowledgements += 1;
              return { exitCode: 0 };
            },
          },
        } as never,
        signal: new AbortController().signal,
        revision: revisionA,
        dependencies: {
          restart: async () => {
            throw new Error("restart failed");
          },
          invalidateAccess: () => {},
        },
      }),
    ).rejects.toThrow("restart failed");
    expect(acknowledgements).toBe(0);
  });

  test("fails before dispatch when the durable acknowledgement cannot be written", async () => {
    await expect(
      applyPendingCodexProviderConfiguration({
        sandbox: {
          process: { executeCommand: async () => ({ exitCode: 1, result: "" }) },
        } as never,
        signal: new AbortController().signal,
        revision: revisionA,
        dependencies: {
          restart: async () => ({}) as never,
          invalidateAccess: () => {},
        },
      }),
    ).rejects.toThrow("configuration acknowledgement failed");
  });

  test("a stale acknowledgement cannot clear a newer pending revision", async () => {
    const home = await mkdtemp(join(tmpdir(), "useagent-codex-plan-fence-"));
    const pending = join(home, `${SANDBOX_STATE_DIR}/t3/caches/useagent-codex-provider-config-pending`);
    try {
      await mkdir(join(home, `${SANDBOX_STATE_DIR}/t3/caches`), { recursive: true });
      expect(
        Bun.spawnSync(
          ["/bin/sh", "-c", buildPendingCodexProviderConfigurationProbeCommand(revisionB)],
          { env: { ...process.env, HOME: home } },
        )
          .stdout?.toString()
          .trim(),
      ).toBe("absent");
      await writeFile(pending, revisionB);
      expect(
        Bun.spawnSync(
          ["/bin/sh", "-c", buildPendingCodexProviderConfigurationProbeCommand(revisionB)],
          { env: { ...process.env, HOME: home } },
        ).exitCode,
      ).toBe(0);
      await writeFile(pending, "truncated");
      expect(
        Bun.spawnSync(
          ["/bin/sh", "-c", buildPendingCodexProviderConfigurationProbeCommand(revisionB)],
          { env: { ...process.env, HOME: home } },
        ).exitCode,
      ).not.toBe(0);
      await writeFile(pending, revisionB);
      const result = Bun.spawnSync(
        ["/bin/sh", "-c", buildAcknowledgeCodexProviderConfigurationCommand(revisionA)],
        { env: { ...process.env, HOME: home } },
      );
      expect(result.exitCode).toBe(0);
      expect(await readFile(pending, "utf8")).toBe(revisionB);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
