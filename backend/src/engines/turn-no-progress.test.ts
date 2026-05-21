import { describe, expect, test } from "bun:test";
import type { T3Activity } from "./t3-orchestration";
import {
  createNoProgressWatchdog,
  MAX_CONSECUTIVE_RETRY_WARNINGS,
  NoProgressError,
  retryWarningReason,
} from "./turn-no-progress";

function retryWarning(id: number, message: string, attempt?: number): T3Activity {
  return {
    id: `warning-${id}`,
    tone: "info",
    kind: "runtime.warning",
    summary: message.slice(0, 120),
    payload: {
      message,
      ...(attempt === undefined
        ? {}
        : { detail: { type: "retry", attempt, message, next: 0 } }),
    },
    turnId: "turn-1",
  };
}

function toolActivity(id: number): T3Activity {
  return {
    id: `tool-${id}`,
    tone: "tool",
    kind: "tool.completed",
    summary: "Ran a command",
    payload: { toolCallId: `call-${id}` },
    turnId: "turn-1",
  };
}

function abortReason(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(signal.reason);
    signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
  });
}

describe("T3 no-progress watchdog", () => {
  test("surfaces the provider's real reason from a retry warning", () => {
    expect(
      retryWarningReason(retryWarning(1, "Internal Server Error: Internal Server Error", 8)),
    ).toBe("retry attempt 8: Internal Server Error: Internal Server Error");
    expect(retryWarningReason(retryWarning(2, "HTTP 500 from provider gateway"))).toBe(
      "HTTP 500 from provider gateway",
    );
    const summaryOnly: T3Activity = {
      id: "warning-summary",
      tone: "info",
      kind: "runtime.warning",
      summary: "Rate limited",
      payload: null,
      turnId: null,
    };
    expect(retryWarningReason(summaryOnly)).toBe("Rate limited");
  });

  test("terminates a stream of consecutive retry warnings with the surfaced reason", () => {
    const watchdog = createNoProgressWatchdog(60_000);
    let failure: unknown;
    try {
      for (let attempt = 1; attempt <= MAX_CONSECUTIVE_RETRY_WARNINGS; attempt += 1) {
        watchdog.observeActivity(
          retryWarning(attempt, "Internal Server Error: Internal Server Error", attempt),
        );
      }
    } catch (error) {
      failure = error;
    } finally {
      watchdog.dispose();
    }
    expect(failure).toBeInstanceOf(NoProgressError);
    expect((failure as Error).message).toBe(
      "T3 provider made no progress (8 consecutive retry warnings): " +
        "retry attempt 8: Internal Server Error: Internal Server Error",
    );
  });

  test("real activity progress resets the consecutive retry-warning count", () => {
    const watchdog = createNoProgressWatchdog(60_000);
    try {
      for (let round = 0; round < 3; round += 1) {
        for (let attempt = 1; attempt < MAX_CONSECUTIVE_RETRY_WARNINGS; attempt += 1) {
          watchdog.observeActivity(retryWarning(round * 10 + attempt, "HTTP 500", attempt));
        }
        watchdog.observeActivity(toolActivity(round));
      }
    } finally {
      watchdog.dispose();
    }
  });

  test("redacts the surfaced reason through the injected sanitizer", () => {
    const watchdog = createNoProgressWatchdog(
      60_000,
      (text) => text.replaceAll("sk-secret-token", "<redacted>"),
      1,
    );
    let failure: unknown;
    try {
      watchdog.observeActivity(retryWarning(1, "401 for key sk-secret-token", 1));
    } catch (error) {
      failure = error;
    } finally {
      watchdog.dispose();
    }
    expect((failure as Error).message).toContain("401 for key <redacted>");
    expect((failure as Error).message).not.toContain("sk-secret-token");
  });

  test("aborts with the latest retry reason when no progress arrives in time", async () => {
    const watchdog = createNoProgressWatchdog(20);
    try {
      watchdog.observeActivity(
        retryWarning(1, "Internal Server Error: Internal Server Error", 3),
      );
      const reason = await abortReason(watchdog.signal);
      expect(reason).toBeInstanceOf(NoProgressError);
      expect((reason as Error).message).toContain("retry warnings in 20ms");
      expect((reason as Error).message).toContain(
        "retry attempt 3: Internal Server Error: Internal Server Error",
      );
    } finally {
      watchdog.dispose();
    }
  });

  test("real progress rearms the no-progress clock", async () => {
    const watchdog = createNoProgressWatchdog(100);
    try {
      // Without rearming, the 100ms bound would fire during this 200ms window.
      for (let tick = 0; tick < 10; tick += 1) {
        await Bun.sleep(20);
        watchdog.observeProgress();
      }
      expect(watchdog.signal.aborted).toBe(false);
    } finally {
      watchdog.dispose();
    }
  });

  test("dispose stops the timer once the turn settles", async () => {
    const watchdog = createNoProgressWatchdog(10);
    watchdog.dispose();
    await Bun.sleep(30);
    expect(watchdog.signal.aborted).toBe(false);
  });
});
