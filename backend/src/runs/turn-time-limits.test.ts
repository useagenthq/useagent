import { describe, expect, test } from "bun:test";
import { MAX_TIMER_DELAY_MS, readTurnTimeLimits, turnTimeoutText } from "./turn-time-limits";

describe("turn time limits", () => {
  test("each limit is read on its own, and an unset one is off", () => {
    expect(readTurnTimeLimits({ ENGINE_MAX_MS: "60000" })).toEqual({
      silenceMs: Number.POSITIVE_INFINITY,
      ceilingMs: 60_000,
    });
    expect(readTurnTimeLimits({ ENGINE_TIMEOUT_MS: "90000" })).toEqual({
      silenceMs: 90_000,
      ceilingMs: Number.POSITIVE_INFINITY,
    });
    expect(readTurnTimeLimits({ ENGINE_TIMEOUT_MS: "300000", ENGINE_MAX_MS: " 3600000 " })).toEqual({
      silenceMs: 300_000,
      ceilingMs: 3_600_000,
    });
  });

  test("unset, empty, non-numeric and non-positive values turn a limit off", () => {
    for (const raw of [undefined, "", "  ", "soon", "0", "-5", "Infinity", "NaN"]) {
      expect(readTurnTimeLimits({ ENGINE_TIMEOUT_MS: raw, ENGINE_MAX_MS: raw })).toEqual({
        silenceMs: Number.POSITIVE_INFINITY,
        ceilingMs: Number.POSITIVE_INFINITY,
      });
    }
  });

  test("a limit past the timer maximum is capped instead of firing at once", () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647);
    expect(readTurnTimeLimits({ ENGINE_TIMEOUT_MS: "3000000000", ENGINE_MAX_MS: "3000000000" })).toEqual({
      silenceMs: 2_147_483_647,
      ceilingMs: 2_147_483_647,
    });
  });

  test("the text names the limit that fired", () => {
    expect(turnTimeoutText(60_000)).toEqual({
      label: "Timed out after 60s",
      summary: "timed out after 60s",
    });
    expect(turnTimeoutText(1_500).label).toBe("Timed out after 1.5s");
  });

  test("no label or summary ever contains Infinity", () => {
    for (const firedMs of [null, Number.POSITIVE_INFINITY]) {
      expect(turnTimeoutText(firedMs)).toEqual({ label: "Timed out", summary: "timed out" });
    }
  });
});
