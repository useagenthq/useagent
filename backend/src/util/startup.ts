// Startup critical-path primitives (perf plan Phase 1).

/** Bounded exponential poll delay: 50ms start, 1.5x growth, 500ms cap. Replaces
 *  fixed one-second readiness loops so a service that comes up in 200ms is seen
 *  in ~200ms, not at the next full-second tick. Pure. */
export function nextPollDelayMs(
  prev: number | null,
  startMs = 50,
  capMs = 500,
  factor = 1.5,
): number {
  if (prev === null) return startMs;
  return Math.min(capMs, Math.max(startMs, Math.round(prev * factor)));
}

/** Rollback flag (perf plan review amendment 5): when set, independent startup
 *  stages run SEQUENTIALLY in their declared order - the SAME dependency DAG at
 *  concurrency 1, not a divergent legacy code path. One env flip de-races
 *  production while every test still exercises the same stages. */
export function serialStartup(): boolean {
  return process.env.SKYNET_SERIAL_STARTUP === "1";
}

/** Run independent startup stages together (Promise.all) or, under
 *  SKYNET_SERIAL_STARTUP=1, one after another in declared order. */
export async function stagesTogether<T extends readonly unknown[]>(
  thunks: { [K in keyof T]: () => Promise<T[K]> },
): Promise<T> {
  if (serialStartup()) {
    const out: unknown[] = [];
    for (const thunk of thunks) out.push(await thunk());
    return out as unknown as T;
  }
  return Promise.all(thunks.map((thunk) => thunk())) as unknown as Promise<T>;
}
