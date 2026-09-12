import { describe, expect, test } from "bun:test";
import {
  createToolCallWatchdog,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  toolCallTimeoutMessage,
  toolCallTimeoutMs,
  type ToolCallExpiry,
} from "./tool-call-watchdog";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("tool call watchdog", () => {
  test("defaults to five minutes and honours TOOL_CALL_TIMEOUT_MS", () => {
    expect(toolCallTimeoutMs({})).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS);
    expect(toolCallTimeoutMs({ TOOL_CALL_TIMEOUT_MS: "90000" })).toBe(90_000);
    expect(toolCallTimeoutMs({ TOOL_CALL_TIMEOUT_MS: "nonsense" })).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS);
    expect(toolCallTimeoutMs({ TOOL_CALL_TIMEOUT_MS: "-1" })).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS);
  });

  test("the failure text names the tool, the ceiling and what it was running", () => {
    expect(toolCallTimeoutMessage("bash", "cat /tmp/changeset-bundle.json", 300_000))
      .toBe("bash tool call timed out after 5m: cat /tmp/changeset-bundle.json");
    expect(toolCallTimeoutMessage("bash", "x".repeat(200), 90_000)).toMatch(/after 1m 30s: x{119}…$/);
  });

  test("a call that runs past the ceiling is reported once with its step payload", async () => {
    const expiries: ToolCallExpiry[] = [];
    const watchdog = createToolCallWatchdog({ timeoutMs: 20, onExpired: (e) => expiries.push(e) });
    watchdog.start("part-1", { tool: "bash", label: "sleep 900", code: { tool: "bash", input: { command: "sleep 900" } } });
    watchdog.start("part-2", { tool: "read", label: "read a.txt", code: { tool: "read" } });
    await sleep(60);
    expect(expiries).toHaveLength(1);
    expect(expiries[0]).toMatchObject({
      id: "part-1",
      tool: "bash",
      label: "sleep 900",
      code: { tool: "bash", input: { command: "sleep 900" } },
    });
    expect(expiries[0]!.message).toBe("bash tool call timed out after 0s: sleep 900");
    expect(watchdog.expired).toBe(expiries[0]!);
    watchdog.stop();
  });

  test("a finished call never expires and stop clears every pending timer", async () => {
    const expiries: ToolCallExpiry[] = [];
    const watchdog = createToolCallWatchdog({ timeoutMs: 20, onExpired: (e) => expiries.push(e) });
    watchdog.start("done", { tool: "bash", label: "true", code: {} });
    watchdog.finish("done");
    watchdog.start("stopped", { tool: "bash", label: "sleep 5", code: {} });
    watchdog.stop();
    await sleep(50);
    expect(expiries).toHaveLength(0);
    expect(watchdog.expired).toBeNull();
  });
});
