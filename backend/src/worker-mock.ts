import type { StepKind } from "./db/schema.js";
import { finalizeRun } from "./runs/finalize.js";
import { publishRunLifecycleChange } from "./runs/org-signals.js";
import { isInternalRunOrigin } from "./runs/origin.js";
import { getRun, insertStep, setRunStatus } from "./runs/repo.js";
import { bus, channel, type BusEvent } from "./worker-events.js";

interface ScriptedStep {
  kind: StepKind;
  label: string;
  chip: string | null;
  code?: unknown;
  delayMs: number;
}

const SCRIPT: ScriptedStep[] = [
  { kind: "command", label: "Cloning repository", chip: "git", delayMs: 1600 },
  { kind: "command", label: "Running Command", chip: "script", delayMs: 1800 },
  { kind: "task", label: "Analyzing codebase", chip: "task", delayMs: 1600 },
  { kind: "file", label: "Editing file", chip: "file", delayMs: 1600 },
  { kind: "file", label: "Editing file", chip: "file", delayMs: 1400 },
  { kind: "file", label: "Editing file", chip: "file", delayMs: 1400 },
  {
    kind: "command",
    label: "Running Command",
    chip: "script",
    code: { taskId: "1", status: "completed" },
    delayMs: 1800,
  },
  { kind: "done", label: "Done", chip: null, delayMs: 300 },
];

const STEP_DELAY_OVERRIDE_MS = process.env.WORKER_STEP_DELAY_MS
  ? Number(process.env.WORKER_STEP_DELAY_MS)
  : null;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function summarize(steps: ScriptedStep[]): string {
  const work = steps.filter((step) => step.kind !== "done");
  const files = work.filter((step) => step.kind === "file").length;
  const commands = work.filter((step) => step.kind === "command").length;
  return `${work.length} tools, edited ${files} files, ran ${commands} commands`;
}

export async function runMock(
  runId: string,
  threadId: string,
  orgId: string | null,
  origin: string | null,
  signal: AbortSignal,
  wasCancelled: () => string | null,
): Promise<void> {
  const startedAt = Date.now();
  await setRunStatus(runId, "running");
  if (!isInternalRunOrigin(origin)) {
    publishRunLifecycleChange({ orgId, threadId, runId, kind: "running" });
  }

  let idx = 0;
  try {
    for (const scripted of SCRIPT) {
      await abortableSleep(STEP_DELAY_OVERRIDE_MS ?? scripted.delayMs, signal);
      const reason = wasCancelled();
      if (reason !== null) {
        const done = await insertStep({
          runId,
          idx,
          kind: "done",
          label: reason,
          chip: null,
          code: null,
        }).catch(() => null);
        if (done) bus.emit(channel(runId), { type: "step", step: done } satisfies BusEvent);
        await finalizeRun(runId, "failed", reason, Date.now() - startedAt);
        bus.emit(channel(runId), { type: "end", status: "failed" } satisfies BusEvent);
        return;
      }
      if (!(await getRun(runId))) return;
      const step = await insertStep({
        runId,
        idx,
        kind: scripted.kind,
        label: scripted.label,
        chip: scripted.chip,
        code: scripted.code ?? null,
      });
      idx += 1;
      bus.emit(channel(runId), { type: "step", step } satisfies BusEvent);
    }

    await finalizeRun(runId, "completed", summarize(SCRIPT), Date.now() - startedAt);
    bus.emit(channel(runId), { type: "end", status: "completed" } satisfies BusEvent);
  } catch (error) {
    console.error(`[worker] run ${runId} failed:`, error);
    await finalizeRun(runId, "failed", "worker error", Date.now() - startedAt);
    bus.emit(channel(runId), { type: "end", status: "failed" } satisfies BusEvent);
  }
}
