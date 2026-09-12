import { describe, expect, test } from "bun:test";
import { DaytonaAuthenticationError, DaytonaNotFoundError } from "@daytona/sdk";
import {
  ensureDaytonaRegistry,
  importDaytonaSnapshot,
  type DaytonaSnapshotImportClient,
} from "./snapshot-import";

type SnapshotRecord = Awaited<ReturnType<DaytonaSnapshotImportClient["snapshot"]["get"]>>;

const config = {
  apiKey: "daytona-key",
  apiUrl: "https://daytona.example.com/api",
  target: "us",
  requestTimeoutMs: 12_000,
};
const image = "registry.example.com/useagent:latest";

function snapshot(
  state: string,
  overrides: Partial<SnapshotRecord> = {},
): SnapshotRecord {
  return {
    name: "useagent-native",
    imageName: image,
    state,
    cpu: 2,
    mem: 8,
    disk: 10,
    errorReason: null,
    ...overrides,
  };
}

function fakeClient(overrides: Partial<DaytonaSnapshotImportClient["snapshot"]> = {}) {
  const calls = {
    creates: [] as unknown[],
    deletes: [] as SnapshotRecord[],
    activations: [] as SnapshotRecord[],
    disposed: 0,
  };
  const client: DaytonaSnapshotImportClient = {
    snapshot: {
      async get() {
        throw new DaytonaNotFoundError("missing", 404);
      },
      async delete(value) {
        calls.deletes.push(value);
      },
      async activate(value) {
        calls.activations.push(value);
        return value;
      },
      async create(params) {
        calls.creates.push(params);
        return snapshot("active");
      },
      ...overrides,
    },
    async [Symbol.asyncDispose]() {
      calls.disposed += 1;
    },
  };
  return { client, calls };
}

describe("importDaytonaSnapshot", () => {
  test("bounds registry metadata requests with the configured request timeout", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;

    try {
      await expect(ensureDaytonaRegistry(
        { ...config, requestTimeoutMs: 5 },
        { url: "registry.example.com", username: "user", password: "secret" },
      )).rejects.toHaveProperty("name", "TimeoutError");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("creates a genuinely absent snapshot with the 2 CPU/8 GiB default and disposes the client", async () => {
    const { client, calls } = fakeClient();

    const result = await importDaytonaSnapshot(
      config,
      { name: "useagent-native", image },
      { createClient: () => client },
    );

    expect(result).toEqual({ name: "useagent-native", state: "active" });
    expect(calls.creates).toEqual([
      {
        name: "useagent-native",
        image,
        resources: { cpu: 2, memory: 8, disk: 10 },
        entrypoint: ["sleep", "infinity"],
      },
    ]);
    expect(calls.disposed).toBe(1);
  });

  test("does not treat authentication or transient lookup failures as absence", async () => {
    for (const error of [
      new DaytonaAuthenticationError("bad key", 401),
      new Error("temporary lookup failure"),
    ]) {
      const { client, calls } = fakeClient({
        async get() {
          throw error;
        },
      });

      await expect(importDaytonaSnapshot(
        config,
        { name: "useagent-native", image },
        { createClient: () => client },
      )).rejects.toBe(error);
      expect(calls.creates).toHaveLength(0);
      expect(calls.disposed).toBe(1);
    }
  });

  test("does not report an undersized active snapshot as usable", async () => {
    const { client, calls } = fakeClient({
      async get() {
        return snapshot("active", { mem: 4 });
      },
    });

    const result = await importDaytonaSnapshot(
      config,
      { name: "useagent-native", image },
      { createClient: () => client },
    );

    expect(result).toEqual({
      name: "useagent-native",
      state: "error",
      detail:
        "active snapshot resources 2 CPU/4 GiB memory/10 GiB disk are below requested " +
        "2 CPU/8 GiB memory/10 GiB disk",
    });
    expect(calls.deletes).toHaveLength(0);
    expect(calls.creates).toHaveLength(0);
    expect(calls.disposed).toBe(1);
  });

  test("rejects existing snapshots with wrong or missing image provenance without mutation", async () => {
    for (const imageName of ["registry.example.com/evil:latest", undefined]) {
      const { client, calls } = fakeClient({
        async get() {
          return snapshot("active", { imageName });
        },
      });

      await expect(importDaytonaSnapshot(
        config,
        { name: "useagent-native", image },
        { createClient: () => client },
      )).resolves.toEqual({
        name: "useagent-native",
        state: "error",
        detail: "existing snapshot provenance does not match the requested image",
      });
      expect(calls.activations).toHaveLength(0);
      expect(calls.deletes).toHaveLength(0);
      expect(calls.creates).toHaveLength(0);
      expect(calls.disposed).toBe(1);
    }
  });

  test("reuses pending snapshots and activates inactive snapshots without deleting either", async () => {
    for (const initial of ["pending", "inactive"]) {
      let current = snapshot(initial);
      const { client, calls } = fakeClient({
        async get() {
          const result = current;
          current = snapshot("active");
          return result;
        },
        async activate(value) {
          calls.activations.push(value);
          current = snapshot("active");
          return snapshot("pending");
        },
      });
      let now = 0;

      const result = await importDaytonaSnapshot(
        config,
        { name: "useagent-native", image },
        {
          createClient: () => client,
          now: () => now,
          sleep: async (ms) => { now += ms; },
        },
      );

      expect(result).toEqual({ name: "useagent-native", state: "active" });
      expect(calls.activations).toHaveLength(initial === "inactive" ? 1 : 0);
      expect(calls.deletes).toHaveLength(0);
      expect(calls.creates).toHaveLength(0);
      expect(calls.disposed).toBe(1);
    }
  });

  test("force waits for confirmed deletion and refuses to create after a delete timeout", async () => {
    let reads = 0;
    const existing = snapshot("active");
    const replaced = fakeClient({
      async get() {
        reads += 1;
        if (reads < 3) return existing;
        throw new DaytonaNotFoundError("gone", 404);
      },
    });
    let replacementNow = 0;

    await expect(importDaytonaSnapshot(
      config,
      {
        name: "useagent-native",
        image,
        force: true,
      },
      {
        createClient: () => replaced.client,
        now: () => replacementNow,
        sleep: async (ms) => { replacementNow += ms; },
      },
    )).resolves.toEqual({ name: "useagent-native", state: "active" });
    expect(replaced.calls.deletes).toEqual([existing]);
    expect(replaced.calls.creates).toHaveLength(1);
    expect(replaced.calls.disposed).toBe(1);

    const stuck = fakeClient({
      async get() {
        return existing;
      },
    });
    let timeoutNow = 0;
    await expect(importDaytonaSnapshot(
      config,
      {
        name: "useagent-native",
        image,
        force: true,
      },
      {
        createClient: () => stuck.client,
        now: () => timeoutNow,
        sleep: async (ms) => { timeoutNow += ms; },
      },
    )).rejects.toThrow("was not deleted within 60 seconds");
    expect(stuck.calls.deletes).toEqual([existing]);
    expect(stuck.calls.creates).toHaveLength(0);
    expect(stuck.calls.disposed).toBe(1);
  });
});
