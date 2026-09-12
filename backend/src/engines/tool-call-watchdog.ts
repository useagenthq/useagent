import { truncate } from "./util";

/** Default ceiling for ONE tool call inside a turn. The per-turn budget
 *  (ENGINE_TIMEOUT_MS) is the only other guard, so without this a single
 *  wedged command kept a turn spinning for the whole budget and then failed
 *  with a message that named nothing. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 300_000;

export function toolCallTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.TOOL_CALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOOL_CALL_TIMEOUT_MS;
}

export interface ToolCallRegistration {
  readonly tool: string;
  /** What the customer saw for the call (the command, the file name). */
  readonly label: string;
  /** The step's current code_json, re-stamped on the failed step. */
  readonly code: Record<string, unknown>;
}

export interface ToolCallExpiry extends ToolCallRegistration {
  readonly id: string;
  readonly elapsedMs: number;
  /** The run-level failure text: names the tool and what it was running. */
  readonly message: string;
}

export interface ToolCallWatchdog {
  start(id: string, call: ToolCallRegistration): void;
  finish(id: string): void;
  /** The first call that ran past the ceiling, once one has. */
  readonly expired: ToolCallExpiry | null;
  stop(): void;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export function toolCallTimeoutMessage(tool: string, label: string, timeoutMs: number): string {
  return `${tool} tool call timed out after ${formatDuration(timeoutMs)}: ${truncate(label, 120)}`;
}

/** Bounds every tool call of a turn. The first call to run past `timeoutMs`
 *  is recorded and reported once through `onExpired`; the caller marks its
 *  step failed and ends the turn with `expired.message`. */
export function createToolCallWatchdog(options: {
  readonly timeoutMs: number;
  readonly onExpired: (expiry: ToolCallExpiry) => void;
}): ToolCallWatchdog {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let expired: ToolCallExpiry | null = null;
  const clear = (id: string): void => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  };
  return {
    start(id, call) {
      if (expired || timers.has(id)) return;
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        timers.delete(id);
        if (expired) return;
        expired = {
          ...call,
          id,
          elapsedMs: Date.now() - startedAt,
          message: toolCallTimeoutMessage(call.tool, call.label, options.timeoutMs),
        };
        options.onExpired(expired);
      }, options.timeoutMs);
      timer.unref?.();
      timers.set(id, timer);
    },
    finish(id) {
      clear(id);
    },
    get expired() {
      return expired;
    },
    stop() {
      for (const id of [...timers.keys()]) clear(id);
    },
  };
}
