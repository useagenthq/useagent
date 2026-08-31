import { afterEach, describe, expect, test } from "bun:test";
import {
  CubeWarmPool,
  claimCubeWarmSandbox,
  cubeRuntimeWarmPoolSize,
  cubeWarmPoolSize,
  resetCubeWarmPoolForTest,
  startCubeWarmPool,
} from "./cube-warm-pool";
import { USEAGENT_WARM_POOL_TEMPLATE_LABEL } from "./cube-warm-pool-reconcile";
import type {
  SandboxCreateOptions,
  SandboxFileSystem,
  SandboxHandle,
  SandboxProcess,
  SandboxProvider,
} from "./provider";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function sandbox(id: string): SandboxHandle & { deleted: boolean } {
  return {
    id,
    cpu: 4,
    memory: 8,
    deleted: false,
    labels: {},
    process: {
      executeCommand: async () => ({ exitCode: 0, result: "" }),
      createSession: async () => undefined,
      deleteSession: async () => undefined,
      getSession: async () => ({ commands: [] }),
      executeSessionCommand: async () => ({ cmdId: "cmd", exitCode: 0 }),
      getSessionCommandLogs: async () => ({ output: "", stdout: "", stderr: "" }),
      createPty: async () => ({
        waitForConnection: async () => undefined,
        sendInput: async () => undefined,
        resize: async () => undefined,
        disconnect: async () => undefined,
        kill: async () => undefined,
      }),
    },
    fs: {} as SandboxFileSystem,
    start: async () => undefined,
    delete: async function deleteSandbox() {
      this.deleted = true;
    },
    getPreviewLink: async () => ({ url: "https://preview.example.test" }),
  };
}

function provider(
  boxes: Array<SandboxHandle & { deleted: boolean }>,
  listed: Array<SandboxHandle & { deleted: boolean }> = [],
): SandboxProvider & { creates: SandboxCreateOptions[] } {
  const creates: SandboxCreateOptions[] = [];
  const created = new Map<string, SandboxHandle & { deleted: boolean }>(
    listed.map((box) => [box.id, box]),
  );
  return {
    creates,
    create: async (options = {}) => {
      creates.push(options);
      const next = boxes.shift();
      if (!next) throw new Error("no sandbox");
      next.labels = options.labels;
      created.set(next.id, next);
      return next;
    },
    get: async (id) => {
      const found = created.get(id);
      if (!found || found.deleted) throw new Error("sandbox not running");
      return found;
    },
    list: async function* list() {
      for (const box of created.values()) {
        if (!box.deleted) yield box;
      }
    },
  };
}

const quietLogger = { log: () => undefined, warn: () => undefined };

async function waitFor<T>(read: () => T | Promise<T>, expected: Awaited<T>): Promise<void> {
  const deadline = Date.now() + 1_000;
  let last: Awaited<T> = await read();
  while (last !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    last = await read();
  }
  expect(last).toBe(expected);
}

afterEach(() => {
  resetCubeWarmPoolForTest();
});

describe("cubeWarmPoolSize gating", () => {
  test("unset / empty / invalid / non-positive all disable the feature", () => {
    expect(cubeWarmPoolSize({})).toBeNull();
    expect(cubeWarmPoolSize({ CUBE_WARM_POOL_SIZE: "" })).toBeNull();
    expect(cubeWarmPoolSize({ CUBE_WARM_POOL_SIZE: "no" })).toBeNull();
    expect(cubeWarmPoolSize({ CUBE_WARM_POOL_SIZE: "0" })).toBeNull();
    expect(cubeWarmPoolSize({ CUBE_WARM_POOL_SIZE: "-1" })).toBeNull();
    expect(cubeWarmPoolSize({ CUBE_WARM_POOL_SIZE: "1.5" })).toBeNull();
  });

  test("a positive integer enables the pool", () => {
    expect(cubeWarmPoolSize({ CUBE_WARM_POOL_SIZE: "1" })).toBe(1);
    expect(cubeWarmPoolSize({ CUBE_WARM_POOL_SIZE: " 3 " })).toBe(3);
  });

  test("the T3 pool uses an independent default-off size gate", () => {
    expect(cubeRuntimeWarmPoolSize({ CUBE_WARM_POOL_SIZE: "3" })).toBeNull();
    expect(cubeRuntimeWarmPoolSize({ CUBE_T3_WARM_POOL_SIZE: "2" })).toBe(2);
  });
});

describe("CubeWarmPool", () => {
  test("warms a real sandbox before claim and uses the requested create options", async () => {
    const box = sandbox("cube-1");
    const fakeProvider = provider([box, sandbox("cube-2")]);
    const warmStages: string[] = [];
    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 1,
      createOptions: { snapshot: "tpl-1", labels: { "skynet-run": "warm-pool" } },
      warmDesktop: async (sb) => {
        expect(sb).toBe(box);
        warmStages.push("desktop");
        return {
          available: true,
          browserTools: true,
          home: "/home/daytona",
          workdir: "/home/daytona/work",
          browserExecutable: "/usr/bin/chromium",
        };
      },
      warmRuntime: async (sb) => {
        expect(sb).toBe(box);
        warmStages.push("runtime");
      },
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 1);
    await expect(pool.claim()).resolves.toBe(box);
    expect(warmStages).toEqual(["desktop", "runtime"]);
    expect(fakeProvider.creates[0]).toEqual({
      snapshot: "tpl-1",
      labels: {
        "skynet-run": "warm-pool",
        [USEAGENT_WARM_POOL_TEMPLATE_LABEL]: "tpl-1",
      },
    });
  });

  test("refills after a claim", async () => {
    const first = sandbox("cube-1");
    const second = sandbox("cube-2");
    const fakeProvider = provider([first, second]);
    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 1,
      createOptions: { snapshot: "tpl-1" },
      warmDesktop: async () => ({
        available: true,
        browserTools: true,
        home: "/home/daytona",
        workdir: "/home/daytona/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 1);
    expect(await pool.claim()).toBe(first);
    await waitFor(() => pool.status().ready, 1);
    expect(fakeProvider.creates).toHaveLength(2);
    expect(await pool.claim()).toBe(second);
  });

  test("warms the desktop and runtime concurrently", async () => {
    const desktopGate = deferred<{
      available: true;
      browserTools: true;
      home: string;
      workdir: string;
      browserExecutable: string;
    }>();
    const runtimeGate = deferred<void>();
    const started = new Set<string>();
    const pool = new CubeWarmPool({
      provider: provider([sandbox("cube-parallel-warm")]),
      size: 1,
      createOptions: { snapshot: "candidate" },
      warmDesktop: async () => {
        started.add("desktop");
        return await desktopGate.promise;
      },
      warmRuntime: async () => {
        started.add("runtime");
        await runtimeGate.promise;
      },
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => started.size, 2);
    expect(pool.status().ready).toBe(0);
    desktopGate.resolve({
      available: true,
      browserTools: true,
      home: "/home/daytona",
      workdir: "/home/daytona/work",
      browserExecutable: "/usr/bin/chromium",
    });
    runtimeGate.resolve();
    await waitFor(() => pool.status().ready, 1);
  });

  test("can claim once without refilling for an isolated benchmark", async () => {
    const box = sandbox("cube-benchmark");
    const fakeProvider = provider([box]);
    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 1,
      createOptions: { snapshot: "candidate" },
      refillAfterClaim: false,
      warmDesktop: async () => ({
        available: true,
        browserTools: true,
        home: "/home/daytona",
        workdir: "/home/daytona/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 1);
    await expect(pool.claim()).resolves.toBe(box);
    expect(fakeProvider.creates).toHaveLength(1);
    expect(pool.status().creating).toBe(0);
  });

  test("dispose deletes every unclaimed ready sandbox", async () => {
    const first = sandbox("cube-ready-1");
    const second = sandbox("cube-ready-2");
    const pool = new CubeWarmPool({
      provider: provider([first, second]),
      size: 2,
      createOptions: { snapshot: "candidate" },
      warmDesktop: async () => ({
        available: true,
        browserTools: true,
        home: "/home/daytona",
        workdir: "/home/daytona/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 2);
    await pool.dispose();
    expect(first.deleted).toBe(true);
    expect(second.deleted).toBe(true);
    expect(pool.status()).toMatchObject({ ready: 0, started: false });
  });

  test("accepts a native computer-use desktop without Playwright browser tools", async () => {
    const box = sandbox("cube-native");
    const pool = new CubeWarmPool({
      provider: provider([box]),
      size: 1,
      createOptions: { snapshot: "tpl-native" },
      warmDesktop: async () => ({
        available: true,
        browserTools: false,
        home: "/root",
        workdir: "/root/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 1);
    expect(await pool.claim()).toBe(box);
  });

  test("concurrent claims receive at most one ready sandbox each", async () => {
    const first = sandbox("cube-1");
    const second = sandbox("cube-2");
    const fakeProvider = provider([first, second, sandbox("cube-3"), sandbox("cube-4")]);
    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 2,
      createOptions: { snapshot: "tpl-1" },
      warmDesktop: async () => ({
        available: true,
        browserTools: true,
        home: "/home/daytona",
        workdir: "/home/daytona/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 2);
    const claimed = await Promise.all([pool.claim(), pool.claim(), pool.claim()]);

    expect(
      claimed
        .filter(Boolean)
        .map((box) => box?.id)
        .toSorted(),
    ).toEqual(["cube-1", "cube-2"]);
    expect(claimed.filter((box) => box === null)).toHaveLength(1);
    await waitFor(() => pool.status().ready, 2);
  });

  test("discards a stale ready entry and never assigns it to a run", async () => {
    const stale = sandbox("cube-stale");
    const replacement = sandbox("cube-replacement");
    const fakeProvider = provider([stale, replacement, sandbox("cube-next")]);
    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 1,
      createOptions: { snapshot: "tpl-1" },
      warmDesktop: async () => ({
        available: true,
        browserTools: false,
        home: "/root",
        workdir: "/root/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 1);
    stale.deleted = true;

    await expect(pool.claim()).resolves.toBe(replacement);
    expect(pool.status().failures).toBe(1);
    expect(stale.deleted).toBe(true);
  });

  test("discards a warm candidate whose provider rejects its runtime identity", async () => {
    const stale = sandbox("cube-uid1000");
    const replacement = sandbox("cube-root");
    const base = provider([stale, replacement, sandbox("cube-next")]);
    const fakeProvider: SandboxProvider = {
      ...base,
      get: async (id) => {
        if (id === stale.id) throw new Error("Cube sandbox did not reach root identity/workspace");
        return base.get(id);
      },
    };
    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 1,
      createOptions: { snapshot: "tpl-1" },
      warmDesktop: async () => ({
        available: true,
        browserTools: false,
        home: "/root",
        workdir: "/root/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 1);

    await expect(pool.claim()).resolves.toBe(replacement);
    expect(stale.deleted).toBe(true);
    expect(pool.status().failures).toBe(1);
  });

  test("deletes failed warmups and keeps refilling without throwing through start", async () => {
    const bad = sandbox("cube-bad");
    const good = sandbox("cube-good");
    const fakeProvider = provider([bad, good]);
    let attempts = 0;
    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 1,
      createOptions: { snapshot: "tpl-1" },
      warmDesktop: async () => {
        attempts += 1;
        return attempts === 1
          ? {
              available: false,
              browserTools: false,
              home: "/home/daytona",
              workdir: "/home/daytona/work",
              browserExecutable: null,
              reason: "browser failed",
            }
          : {
              available: true,
              browserTools: true,
              home: "/home/daytona",
              workdir: "/home/daytona/work",
              browserExecutable: "/usr/bin/chromium",
            };
      },
      initialRetryDelayMs: 50,
      maxRetryDelayMs: 50,
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().failures, 1);
    expect(fakeProvider.creates).toHaveLength(1);
    await waitFor(() => pool.status().ready, 1);
    expect(bad.deleted).toBe(true);
    expect(await pool.claim()).toBe(good);
  });

  test("reconciles a failed warmup when cleanup delete fails before creating replacements", async () => {
    const bad = sandbox("cube-bad-delete-fails");
    const good = sandbox("cube-good-after-cleanup");
    const fakeProvider = provider([bad, good]);
    let warmAttempts = 0;
    let deleteAttempts = 0;
    bad.delete = async () => {
      deleteAttempts += 1;
      if (deleteAttempts === 1) throw new Error("delete failed");
      bad.deleted = true;
    };

    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 1,
      createOptions: { snapshot: "tpl-1", labels: { "skynet-run": "warm-pool" } },
      warmDesktop: async () => {
        warmAttempts += 1;
        return warmAttempts < 3
          ? {
              available: false,
              browserTools: false,
              home: "/home/daytona",
              workdir: "/home/daytona/work",
              browserExecutable: null,
              reason: "browser failed",
            }
          : {
              available: true,
              browserTools: true,
              home: "/home/daytona",
              workdir: "/home/daytona/work",
              browserExecutable: "/usr/bin/chromium",
            };
      },
      protectedSandboxIds: async () => new Set(),
      initialRetryDelayMs: 100,
      maxRetryDelayMs: 100,
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().failures, 1);
    expect(fakeProvider.creates).toHaveLength(1);
    expect(bad.deleted).toBe(false);
    await waitFor(() => pool.status().ready, 1);
    expect(deleteAttempts).toBe(2);
    expect(bad.deleted).toBe(true);
    expect(fakeProvider.creates).toHaveLength(2);
    expect((await pool.claim())?.id).toBe("cube-good-after-cleanup");
  });

  test("singleton claim is inert until the pool is started", async () => {
    expect(await claimCubeWarmSandbox()).toBeNull();

    const box = sandbox("cube-1");
    startCubeWarmPool({
      provider: provider([box]),
      size: 1,
      createOptions: { snapshot: "tpl-1" },
      warmDesktop: async () => ({
        available: true,
        browserTools: true,
        home: "/home/daytona",
        workdir: "/home/daytona/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      logger: quietLogger,
    });

    await waitFor(async () => (await claimCubeWarmSandbox())?.id ?? null, "cube-1");
  });

  test("named pools never hand a legacy sandbox to a T3 claim", async () => {
    const legacy = sandbox("cube-legacy");
    const t3 = sandbox("cube-t3");
    const desktop = async () => ({
      available: true as const,
      browserTools: true,
      home: "/home/daytona",
      workdir: "/home/daytona/work",
      browserExecutable: "/usr/bin/chromium",
    });
    const legacyPool = startCubeWarmPool({
      provider: provider([legacy]),
      size: 1,
      createOptions: { snapshot: "legacy" },
      warmDesktop: desktop,
      logger: quietLogger,
    });
    const runtimePool = startCubeWarmPool({
      name: "t3-v2",
      provider: provider([t3]),
      size: 1,
      createOptions: { snapshot: "candidate" },
      warmDesktop: desktop,
      logger: quietLogger,
    });

    await waitFor(() => legacyPool.status().ready, 1);
    await waitFor(() => runtimePool.status().ready, 1);
    await expect(claimCubeWarmSandbox("t3-v2")).resolves.toBe(t3);
    await expect(claimCubeWarmSandbox()).resolves.toBe(legacy);
  });

  test("does not hand out a sandbox before desktop/browser warmup resolves", async () => {
    const gate = deferred<{
      available: true;
      browserTools: true;
      home: string;
      workdir: string;
      browserExecutable: string;
    }>();
    const box = sandbox("cube-1");
    const pool = new CubeWarmPool({
      provider: provider([box]),
      size: 1,
      createOptions: { snapshot: "tpl-1" },
      warmDesktop: async () => await gate.promise,
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().creating, 1);
    expect(await pool.claim()).toBeNull();
    gate.resolve({
      available: true,
      browserTools: true,
      home: "/home/daytona",
      workdir: "/home/daytona/work",
      browserExecutable: "/usr/bin/chromium",
    });
    await waitFor(() => pool.status().ready, 1);
    expect(await pool.claim()).toBe(box);
  });

  test("can warm a runtime-only pool without desktop/noVNC readiness", async () => {
    const box = sandbox("cube-t3-runtime-only");
    let runtimeCalls = 0;
    let desktopCalls = 0;
    const pool = new CubeWarmPool({
      provider: provider([box]),
      size: 1,
      createOptions: { snapshot: "t3-candidate" },
      requireDesktop: false,
      warmDesktop: async () => {
        desktopCalls += 1;
        throw new Error("desktop should not be on the runtime-only path");
      },
      warmRuntime: async () => {
        runtimeCalls += 1;
      },
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 1);
    expect(runtimeCalls).toBe(1);
    expect(desktopCalls).toBe(0);
    expect(await pool.claim()).toBe(box);
  });

  test("adopts existing exact-pool candidates on restart before creating replacements", async () => {
    const first = sandbox("cube-existing-1");
    const second = sandbox("cube-existing-2");
    const fakeProvider = provider([], [first, second]);
    const warmed: string[] = [];
    first.labels = {
      "skynet-run": "warm-pool:t3-v3",
      "cube.master.appsnapshot.template.id": "tpl-t3",
    };
    second.labels = {
      "skynet-run": "warm-pool:t3-v3",
      "cube.master.appsnapshot.template.id": "tpl-t3",
    };

    const pool = new CubeWarmPool({
      name: "t3-v3",
      provider: fakeProvider,
      size: 2,
      requireDesktop: false,
      createOptions: {
        snapshot: "tpl-t3",
        labels: { "skynet-run": "warm-pool:t3-v3" },
      },
      warmRuntime: async (box) => {
        warmed.push(box.id);
      },
      protectedSandboxIds: async () => new Set(),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 2);
    expect(fakeProvider.creates).toHaveLength(0);
    expect(warmed.toSorted()).toEqual(["cube-existing-1", "cube-existing-2"]);
    expect((await pool.claim())?.id).toBe("cube-existing-1");
  });

  test("does not adopt an exact-pool candidate from an older Cube template", async () => {
    const oldTemplate = sandbox("cube-old-template");
    const currentTemplate = sandbox("cube-current-template");
    oldTemplate.labels = {
      "skynet-run": "warm-pool:t3-v3",
      "cube.master.appsnapshot.template.id": "tpl-old",
    };
    currentTemplate.labels = {
      "skynet-run": "warm-pool:t3-v3",
      "cube.master.appsnapshot.template.id": "tpl-new",
    };

    const pool = new CubeWarmPool({
      name: "t3-v3",
      provider: provider([], [oldTemplate, currentTemplate]),
      size: 1,
      requireDesktop: false,
      createOptions: {
        snapshot: "tpl-new",
        labels: { "skynet-run": "warm-pool:t3-v3" },
      },
      protectedSandboxIds: async () => new Set(),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 1);
    expect(oldTemplate.deleted).toBe(true);
    expect((await pool.claim())?.id).toBe("cube-current-template");
  });

  test("uses the useAgent template label before Cube system labels", async () => {
    const conflictingTemplate = sandbox("cube-conflicting-template");
    const currentTemplate = sandbox("cube-current-template");
    conflictingTemplate.labels = {
      "skynet-run": "warm-pool:t3-v3",
      [USEAGENT_WARM_POOL_TEMPLATE_LABEL]: "tpl-old",
      "cube.master.appsnapshot.template.id": "tpl-new",
    };
    currentTemplate.labels = {
      "skynet-run": "warm-pool:t3-v3",
      [USEAGENT_WARM_POOL_TEMPLATE_LABEL]: "tpl-new",
    };

    const pool = new CubeWarmPool({
      name: "t3-v3",
      provider: provider([], [conflictingTemplate, currentTemplate]),
      size: 1,
      requireDesktop: false,
      createOptions: {
        snapshot: "tpl-new",
        labels: { "skynet-run": "warm-pool:t3-v3" },
      },
      protectedSandboxIds: async () => new Set(),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 1);
    expect(conflictingTemplate.deleted).toBe(true);
    expect((await pool.claim())?.id).toBe("cube-current-template");
  });

  test("deletes unbound pool candidates with missing template metadata", async () => {
    const missingTemplate = sandbox("cube-missing-template");
    const fresh = sandbox("cube-fresh");
    const fakeProvider = provider([fresh], [missingTemplate]);
    missingTemplate.labels = { "skynet-run": "warm-pool" };

    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 1,
      createOptions: {
        snapshot: "tpl-opencode",
        labels: { "skynet-run": "warm-pool" },
      },
      warmDesktop: async () => ({
        available: true,
        browserTools: true,
        home: "/home/daytona",
        workdir: "/home/daytona/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      protectedSandboxIds: async () => new Set(),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => missingTemplate.deleted, true);
    await waitFor(() => pool.status().ready, 1);
    expect(fakeProvider.creates).toHaveLength(1);
    expect((await pool.claim())?.id).toBe("cube-fresh");
  });

  test("retries reconciliation after delete failure without creating extra sandboxes", async () => {
    const oldTemplate = sandbox("cube-old-template-delete-fails");
    const fresh = sandbox("cube-fresh-after-delete-retry");
    const fakeProvider = provider([fresh], [oldTemplate]);
    let deleteAttempts = 0;
    oldTemplate.labels = {
      "skynet-run": "warm-pool",
      "cube.master.appsnapshot.template.id": "tpl-old",
    };
    oldTemplate.delete = async () => {
      deleteAttempts += 1;
      if (deleteAttempts === 1) throw new Error("delete failed");
      oldTemplate.deleted = true;
    };

    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 1,
      createOptions: {
        snapshot: "tpl-new",
        labels: { "skynet-run": "warm-pool" },
      },
      warmDesktop: async () => ({
        available: true,
        browserTools: true,
        home: "/home/daytona",
        workdir: "/home/daytona/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      protectedSandboxIds: async () => new Set(),
      initialRetryDelayMs: 10,
      maxRetryDelayMs: 10,
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().failures, 1);
    expect(oldTemplate.deleted).toBe(false);
    expect(fakeProvider.creates).toHaveLength(0);
    await waitFor(() => pool.status().ready, 1);
    expect(deleteAttempts).toBe(2);
    expect(oldTemplate.deleted).toBe(true);
    expect(fakeProvider.creates).toHaveLength(1);
    expect((await pool.claim())?.id).toBe("cube-fresh-after-delete-retry");
  });

  test("keeps adopted candidates ready when a later surplus delete retries", async () => {
    const adopted = sandbox("cube-adopted-before-delete-fails");
    const surplus = sandbox("cube-surplus-delete-retries");
    const fakeProvider = provider([], [adopted, surplus]);
    let deleteAttempts = 0;
    adopted.labels = {
      "skynet-run": "warm-pool",
      "cube.master.appsnapshot.template.id": "tpl-opencode",
    };
    surplus.labels = {
      "skynet-run": "warm-pool",
      "cube.master.appsnapshot.template.id": "tpl-opencode",
    };
    surplus.delete = async () => {
      deleteAttempts += 1;
      if (deleteAttempts === 1) throw new Error("delete failed");
      surplus.deleted = true;
    };

    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 1,
      createOptions: {
        snapshot: "tpl-opencode",
        labels: { "skynet-run": "warm-pool" },
      },
      warmDesktop: async () => ({
        available: true,
        browserTools: true,
        home: "/home/daytona",
        workdir: "/home/daytona/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      protectedSandboxIds: async () => new Set(),
      initialRetryDelayMs: 10,
      maxRetryDelayMs: 10,
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().failures, 1);
    expect(pool.status().ready).toBe(1);
    expect(adopted.deleted).toBe(false);
    expect(surplus.deleted).toBe(false);
    expect(fakeProvider.creates).toHaveLength(0);
    await waitFor(() => surplus.deleted, true);
    expect(deleteAttempts).toBe(2);
    expect(adopted.deleted).toBe(false);
    expect(fakeProvider.creates).toHaveLength(0);
    expect((await pool.claim())?.id).toBe("cube-adopted-before-delete-fails");
  });

  test("deletes only unbound surplus exact-pool candidates after adopting the target", async () => {
    const keep = sandbox("cube-keep");
    const surplus = sandbox("cube-surplus");
    keep.labels = {
      "skynet-run": "warm-pool",
      "cube.master.appsnapshot.template.id": "tpl-opencode",
    };
    surplus.labels = {
      "skynet-run": "warm-pool",
      "cube.master.appsnapshot.template.id": "tpl-opencode",
    };

    const pool = new CubeWarmPool({
      provider: provider([], [keep, surplus]),
      size: 1,
      createOptions: {
        snapshot: "tpl-opencode",
        labels: { "skynet-run": "warm-pool" },
      },
      warmDesktop: async () => ({
        available: true,
        browserTools: true,
        home: "/home/daytona",
        workdir: "/home/daytona/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      protectedSandboxIds: async () => new Set(),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 1);
    expect(keep.deleted).toBe(false);
    expect(surplus.deleted).toBe(true);
  });

  test("never adopts or deletes exact-pool candidates durably bound to runs or threads", async () => {
    const protectedBox = sandbox("cube-thread");
    const unbound = sandbox("cube-unbound");
    protectedBox.labels = { "skynet-run": "warm-pool:t3-v3" };
    unbound.labels = {
      "skynet-run": "warm-pool:t3-v3",
      "cube.master.appsnapshot.template.id": "tpl-t3",
    };

    const pool = new CubeWarmPool({
      name: "t3-v3",
      provider: provider([], [protectedBox, unbound]),
      size: 1,
      requireDesktop: false,
      createOptions: {
        snapshot: "tpl-t3",
        labels: { "skynet-run": "warm-pool:t3-v3" },
      },
      protectedSandboxIds: async () => new Set(["cube-thread"]),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 1);
    expect(protectedBox.deleted).toBe(false);
    expect((await pool.claim())?.id).toBe("cube-unbound");
  });

  test("ignores retained thread sandboxes with non-pool run labels", async () => {
    const retained = sandbox("cube-retained-thread");
    const warm = sandbox("cube-warm");
    const fakeProvider = provider([], [retained, warm]);
    retained.labels = { "skynet-run": "run-123" };
    warm.labels = {
      "skynet-run": "warm-pool",
      "cube.master.appsnapshot.template.id": "tpl-opencode",
    };

    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 1,
      createOptions: {
        snapshot: "tpl-opencode",
        labels: { "skynet-run": "warm-pool" },
      },
      warmDesktop: async () => ({
        available: true,
        browserTools: true,
        home: "/home/daytona",
        workdir: "/home/daytona/work",
        browserExecutable: "/usr/bin/chromium",
      }),
      protectedSandboxIds: async () => new Set(),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().ready, 1);
    expect(retained.deleted).toBe(false);
    expect((await pool.claim())?.id).toBe("cube-warm");
  });

  test("deletes an adopted candidate instead of readying it if the pool stops during readiness proof", async () => {
    const gate = deferred<void>();
    const candidate = sandbox("cube-adopting");
    candidate.labels = {
      "skynet-run": "warm-pool",
      "cube.master.appsnapshot.template.id": "tpl-opencode",
    };
    let runtimeStarted = false;

    const pool = new CubeWarmPool({
      provider: provider([], [candidate]),
      size: 1,
      requireDesktop: false,
      createOptions: {
        snapshot: "tpl-opencode",
        labels: { "skynet-run": "warm-pool" },
      },
      warmRuntime: async () => {
        runtimeStarted = true;
        await gate.promise;
      },
      protectedSandboxIds: async () => new Set(),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => runtimeStarted, true);
    pool.stop();
    gate.resolve();
    await waitFor(() => candidate.deleted, true);
    expect(pool.status().ready).toBe(0);
  });

  test("deletes stale unbound exact-pool candidates and refills to target", async () => {
    const stale = sandbox("cube-stale-existing");
    const fresh = sandbox("cube-fresh");
    const fakeProvider = provider([fresh], [stale]);
    stale.labels = {
      "skynet-run": "warm-pool",
      "cube.master.appsnapshot.template.id": "tpl-opencode",
    };
    let warmAttempts = 0;

    const pool = new CubeWarmPool({
      provider: fakeProvider,
      size: 1,
      createOptions: {
        snapshot: "tpl-opencode",
        labels: { "skynet-run": "warm-pool" },
      },
      warmDesktop: async () => {
        warmAttempts += 1;
        if (warmAttempts === 1) {
          return {
            available: false,
            browserTools: false,
            home: "/home/daytona",
            workdir: "/home/daytona/work",
            browserExecutable: null,
            reason: "stale desktop",
          };
        }
        return {
          available: true,
          browserTools: true,
          home: "/home/daytona",
          workdir: "/home/daytona/work",
          browserExecutable: "/usr/bin/chromium",
        };
      },
      protectedSandboxIds: async () => new Set(),
      logger: quietLogger,
    });

    pool.start();
    await waitFor(() => pool.status().failures, 1);
    await waitFor(() => pool.status().ready, 1);
    expect(stale.deleted).toBe(true);
    expect(fakeProvider.creates).toHaveLength(1);
    expect((await pool.claim())?.id).toBe("cube-fresh");
  });
});
