import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createSlidingInactivityWatchdog } from "./inactivity-watchdog";

describe("outer run inactivity watchdog", () => {
  test("real activity keeps extending one sliding silence window", async () => {
    let timedOut = false;
    const watchdog = createSlidingInactivityWatchdog(80, () => {
      timedOut = true;
    });
    try {
      for (let index = 0; index < 5; index += 1) {
        await Bun.sleep(20);
        watchdog.touch();
      }
      expect(timedOut).toBe(false);
      await Bun.sleep(100);
      expect(timedOut).toBe(true);
    } finally {
      watchdog.dispose();
    }
  });

  test("genuine silence still times out and dispose cannot re-arm it", async () => {
    let timeouts = 0;
    const watchdog = createSlidingInactivityWatchdog(30, () => {
      timeouts += 1;
    });
    await Bun.sleep(60);
    expect(timeouts).toBe(1);
    watchdog.dispose();
    watchdog.touch();
    await Bun.sleep(40);
    expect(timeouts).toBe(1);
  });

  test("step, delta, native frame, and tool heartbeat feed the canonical touch signal", async () => {
    const [worker, runtime] = await Promise.all([
      readFile(new URL("../worker.ts", import.meta.url), "utf8"),
      readFile(new URL("../engines/runtime-adapter.ts", import.meta.url), "utf8"),
    ]);
    expect(worker).toContain("createSlidingInactivityWatchdog(");
    expect(worker).toContain("subscribeNative(runId, activity.touch)");
    expect(worker).toContain("if (event.type === \"step\") activity.touch()");
    expect(worker).toContain("activity.touch,");
    expect(worker).toContain("reportActivity();");
    expect(worker).toContain("reportActivity,");
    expect(runtime).toContain("ctx.reportActivity?.()");
  });
});
