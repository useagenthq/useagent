import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureWarmPool,
  setWarmPoolTransportForTest,
  warmPoolSize,
  warmPoolStatus,
  type WarmPoolTransport,
} from "./warm-pool";

// A recording transport backed by an in-memory pool list; no network.
interface Row {
  id: string;
  snapshot: string;
  target: string;
  pool: number;
  currentSize: number;
  errorReason?: string | null;
}

function fakeTransport(
  rows: Row[],
  opts: { createStatus?: number } = {},
): { transport: WarmPoolTransport; calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const transport: WarmPoolTransport = async ({ method, path, body }) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/warm-pools") return { status: 200, data: rows };
    if (method === "POST" && path === "/warm-pools") {
      const b = body as { snapshot: string; pool: number; target: string };
      return {
        status: opts.createStatus ?? 201,
        data: { id: "wp-new", snapshot: b.snapshot, target: b.target, pool: b.pool, currentSize: 0 },
      };
    }
    if (method === "PATCH") {
      const id = path.split("/").pop();
      const found = rows.find((r) => r.id === id);
      const b = body as { pool: number };
      return { status: 200, data: { ...found, pool: b.pool } };
    }
    return { status: 404, data: null };
  };
  return { transport, calls };
}

describe("warmPoolSize gating", () => {
  test("unset / empty / invalid / non-positive all disable the feature", () => {
    expect(warmPoolSize({})).toBeNull();
    expect(warmPoolSize({ DAYTONA_WARM_POOL_SIZE: "" })).toBeNull();
    expect(warmPoolSize({ DAYTONA_WARM_POOL_SIZE: "abc" })).toBeNull();
    expect(warmPoolSize({ DAYTONA_WARM_POOL_SIZE: "0" })).toBeNull();
    expect(warmPoolSize({ DAYTONA_WARM_POOL_SIZE: "-2" })).toBeNull();
    expect(warmPoolSize({ DAYTONA_WARM_POOL_SIZE: "1.5" })).toBeNull();
  });

  test("a positive integer enables it (whitespace tolerated)", () => {
    expect(warmPoolSize({ DAYTONA_WARM_POOL_SIZE: "2" })).toBe(2);
    expect(warmPoolSize({ DAYTONA_WARM_POOL_SIZE: " 5 " })).toBe(5);
  });
});

describe("ensureWarmPool reconciliation", () => {
  let priorApiKey: string | undefined;
  let priorTarget: string | undefined;

  beforeEach(() => {
    priorApiKey = process.env.DAYTONA_API_KEY;
    priorTarget = process.env.DAYTONA_TARGET;
    process.env.DAYTONA_API_KEY = "test-key";
    process.env.DAYTONA_TARGET = "us";
  });
  afterEach(() => {
    setWarmPoolTransportForTest(null);
    if (priorApiKey === undefined) delete process.env.DAYTONA_API_KEY;
    else process.env.DAYTONA_API_KEY = priorApiKey;
    if (priorTarget === undefined) delete process.env.DAYTONA_TARGET;
    else process.env.DAYTONA_TARGET = priorTarget;
  });

  test("creates a pool when none exists for the snapshot+target", async () => {
    const { transport, calls } = fakeTransport([]);
    setWarmPoolTransportForTest(transport);

    const report = await ensureWarmPool("snap-a", 2);

    expect(report).toEqual({ snapshot: "snap-a", target: "us", desired: 2, ready: 0, errorReason: null });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ snapshot: "snap-a", pool: 2, target: "us" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  test("creates a distinct pool when only a different snapshot exists", async () => {
    const { transport, calls } = fakeTransport([
      { id: "wp-other", snapshot: "snap-other", target: "us", pool: 2, currentSize: 2 },
    ]);
    setWarmPoolTransportForTest(transport);

    await ensureWarmPool("snap-a", 2);

    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });

  test("resizes in place when the pool exists with a different desired size", async () => {
    const { transport, calls } = fakeTransport([
      { id: "wp-1", snapshot: "snap-a", target: "us", pool: 1, currentSize: 1 },
    ]);
    setWarmPoolTransportForTest(transport);

    const report = await ensureWarmPool("snap-a", 3);

    expect(report.desired).toBe(3);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/warm-pools/wp-1");
    expect(patch?.body).toEqual({ pool: 3 });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("no create/resize when the pool already matches the desired size", async () => {
    const { transport, calls } = fakeTransport([
      { id: "wp-1", snapshot: "snap-a", target: "us", pool: 2, currentSize: 2 },
    ]);
    setWarmPoolTransportForTest(transport);

    const report = await ensureWarmPool("snap-a", 2);

    expect(report).toEqual({ snapshot: "snap-a", target: "us", desired: 2, ready: 2, errorReason: null });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("throws on a non-2xx create", async () => {
    const { transport } = fakeTransport([], { createStatus: 500 });
    setWarmPoolTransportForTest(transport);

    await expect(ensureWarmPool("snap-a", 2)).rejects.toThrow(/warm-pool create failed: HTTP 500/);
  });

  test("warmPoolStatus maps pools to desired/ready reports", async () => {
    const { transport } = fakeTransport([
      { id: "wp-1", snapshot: "snap-a", target: "us", pool: 2, currentSize: 1, errorReason: "boot" },
    ]);
    setWarmPoolTransportForTest(transport);

    const status = await warmPoolStatus();

    expect(status).toEqual([
      { snapshot: "snap-a", target: "us", desired: 2, ready: 1, errorReason: "boot" },
    ]);
  });
});
