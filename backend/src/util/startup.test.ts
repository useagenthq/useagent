import { afterEach, describe, expect, test } from "bun:test";
import { nextPollDelayMs, serialStartup, stagesTogether } from "./startup";

const FLAG = "USEAGENT_SERIAL_STARTUP";
const savedFlag = process.env[FLAG];

afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

describe("nextPollDelayMs", () => {
  test("bounded exponential schedule: 50 start, 1.5x growth, 500 cap", () => {
    const delays: number[] = [];
    let prev: number | null = null;
    for (let i = 0; i < 8; i++) {
      prev = nextPollDelayMs(prev);
      delays.push(prev);
    }
    expect(delays).toEqual([50, 75, 113, 170, 255, 383, 500, 500]);
  });

  test("never returns below start or above cap", () => {
    expect(nextPollDelayMs(1)).toBe(50);
    expect(nextPollDelayMs(10_000)).toBe(500);
  });
});

describe("stagesTogether", () => {
  const staged = (order: string[], name: string, ms: number, value: string) => async () => {
    order.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${name}:end`);
    return value;
  };

  test("default: stages run concurrently and results keep declared order", async () => {
    delete process.env[FLAG];
    const order: string[] = [];
    const [a, b] = await stagesTogether([
      staged(order, "a", 30, "A"),
      staged(order, "b", 5, "B"),
    ]);
    expect(a).toBe("A");
    expect(b).toBe("B");
    // b starts before a ends - concurrency proven.
    expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("a:end"));
  });

  test("USEAGENT_SERIAL_STARTUP=1: same stages, same order, concurrency 1", async () => {
    process.env[FLAG] = "1";
    expect(serialStartup()).toBe(true);
    const order: string[] = [];
    const [a, b] = await stagesTogether([
      staged(order, "a", 10, "A"),
      staged(order, "b", 1, "B"),
    ]);
    expect(a).toBe("A");
    expect(b).toBe("B");
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("serial mode: a failing stage stops later stages (same fail-closed shape as Promise.all)", async () => {
    process.env[FLAG] = "1";
    const order: string[] = [];
    await expect(
      stagesTogether([
        async () => {
          order.push("a");
          throw new Error("boom");
        },
        async () => {
          order.push("b");
          return "B";
        },
      ]),
    ).rejects.toThrow("boom");
    expect(order).toEqual(["a"]);
  });
});
