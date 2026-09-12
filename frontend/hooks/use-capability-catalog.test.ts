import { describe, expect, test } from "bun:test";
import type { CapabilityCatalog } from "@/lib/capability-catalog";
import {
  CAPABILITY_CATALOG_RETRY_DELAYS_MS,
  pollCapabilityCatalog,
} from "./use-capability-catalog";

type TimerHandle = ReturnType<typeof setTimeout>;

class FakeTimers {
  now = 0;
  clearCount = 0;
  private nextHandle = 1;
  private readonly timers = new Map<TimerHandle, { callback: () => void; runAt: number }>();

  readonly setTimer = (callback: () => void, delayMs: number): TimerHandle => {
    const handle = this.nextHandle as unknown as TimerHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { callback, runAt: this.now + delayMs });
    return handle;
  };

  readonly clearTimer = (handle: TimerHandle) => {
    if (this.timers.delete(handle)) this.clearCount += 1;
  };

  get pendingCount(): number {
    return this.timers.size;
  }

  async runNext(): Promise<void> {
    const next = [...this.timers.entries()].sort((a, b) => a[1].runAt - b[1].runAt)[0];
    if (!next) throw new Error("No timer is pending");
    const [handle, timer] = next;
    this.timers.delete(handle);
    this.now = timer.runAt;
    timer.callback();
    await settlePromises();
  }
}

function capabilityCatalog(stale: boolean): CapabilityCatalog {
  return {
    version: 1,
    scope: "pre_run",
    bots: false,
    engines: [
      {
        id: "codex",
        configured: true,
        ready: !stale,
        defaultModel: stale ? "" : "gpt-5.6-sol",
        models: [],
        modelCatalog: {
          source: "native",
          stale,
          ...(stale ? { error: "native_catalog_refreshing" } : {}),
        },
        runtime: { kind: "native", label: "Codex agent" },
      },
    ],
    tools: { gatewayConfigured: false, declared: [] },
    nativeSlashCommands: { catalog: "session_runtime", currentRun: null },
  };
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("capability catalog refresh polling", () => {
  test("keeps polling when the native refresh completes after four seconds", async () => {
    const timers = new FakeTimers();
    const published: CapabilityCatalog[] = [];
    let fetchCount = 0;

    pollCapabilityCatalog(
      ({ catalog }) => {
        if (catalog) published.push(catalog);
      },
      {
        fetchCatalog: async () => capabilityCatalog(++fetchCount < 6),
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      },
    );
    await settlePromises();

    for (let attempt = 0; attempt < 5; attempt += 1) await timers.runNext();

    expect(timers.now).toBe(16_000);
    expect(fetchCount).toBe(6);
    expect(published.at(-1)?.engines[0]?.modelCatalog?.stale).toBe(false);
    expect(timers.pendingCount).toBe(0);
  });

  test("stops after the bounded refresh window", async () => {
    const timers = new FakeTimers();
    let fetchCount = 0;

    pollCapabilityCatalog(() => {}, {
      fetchCatalog: async () => {
        fetchCount += 1;
        return capabilityCatalog(true);
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await settlePromises();

    while (timers.pendingCount > 0) await timers.runNext();

    expect(timers.now).toBe(
      CAPABILITY_CATALOG_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0),
    );
    expect(fetchCount).toBe(CAPABILITY_CATALOG_RETRY_DELAYS_MS.length + 1);
    expect(timers.pendingCount).toBe(0);
  });

  test("clears the scheduled refresh when the hook unmounts", async () => {
    const timers = new FakeTimers();
    let fetchCount = 0;
    const cancel = pollCapabilityCatalog(() => {}, {
      fetchCatalog: async () => {
        fetchCount += 1;
        return capabilityCatalog(true);
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await settlePromises();

    expect(timers.pendingCount).toBe(1);
    cancel();

    expect(timers.clearCount).toBe(1);
    expect(timers.pendingCount).toBe(0);
    expect(fetchCount).toBe(1);
  });

  test("ignores an in-flight response after the hook unmounts", async () => {
    const timers = new FakeTimers();
    const published: CapabilityCatalog[] = [];
    let resolveFetch: ((catalog: CapabilityCatalog) => void) | undefined;
    const fetchCatalog = new Promise<CapabilityCatalog>((resolve) => {
      resolveFetch = resolve;
    });
    const cancel = pollCapabilityCatalog(
      ({ catalog }) => {
        if (catalog) published.push(catalog);
      },
      {
        fetchCatalog: () => fetchCatalog,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      },
    );

    cancel();
    resolveFetch?.(capabilityCatalog(true));
    await settlePromises();

    expect(published).toEqual([]);
    expect(timers.pendingCount).toBe(0);
  });
});
