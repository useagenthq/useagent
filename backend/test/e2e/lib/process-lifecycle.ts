export interface OwnedProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function exitsWithin(process: OwnedProcess, budgetMs: number): Promise<boolean> {
  return Promise.race([
    process.exited.then(() => true, () => true),
    delay(budgetMs).then(() => false),
  ]);
}

/** Terminate an owned child without allowing a stuck process to hang test teardown. */
export async function stopOwnedProcess(
  process: OwnedProcess | null | undefined,
  budgetMs = 5_000,
): Promise<void> {
  if (!process) return;
  process.kill("SIGTERM");
  if (await exitsWithin(process, budgetMs)) return;
  process.kill("SIGKILL");
  if (!(await exitsWithin(process, budgetMs))) {
    throw new Error(`child process ${process.pid} did not exit after SIGKILL`);
  }
}

/** Always attempts every teardown before reporting the combined failure. */
export async function stopOwnedProcesses(
  processes: readonly (OwnedProcess | null | undefined)[],
  budgetMs = 5_000,
): Promise<void> {
  const results = await Promise.allSettled(
    processes.map((process) => stopOwnedProcess(process, budgetMs)),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "one or more owned child processes did not stop");
  }
}
