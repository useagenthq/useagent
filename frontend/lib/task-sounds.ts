import type { RunStatus } from "@useagent/agent-client/wire";

/**
 * The sound grammar for work. A cue marks a moment in a task's life and never
 * a click: sending work, work finishing where you are looking, work finishing
 * somewhere else, work failing, work being cancelled. Chrome (hover, press,
 * switches, navigation) stays silent on purpose - this is a work surface, and
 * a sound has to mean "something happened to your work".
 */
export type TaskMoment = "sent" | "done-here" | "done-elsewhere" | "failed" | "cancelled";

/** The sound names, chosen for what each one says (cuelume.dev/docs). */
export type TaskCue = "loading" | "success" | "ready" | "error" | "droplet";

export const TASK_CUES: Readonly<Record<TaskMoment, TaskCue>> = {
  // A brief unresolved shimmer: you started something, it is not done.
  sent: "loading",
  // A warm confirmation: you were watching, and it finished.
  "done-here": "success",
  // A rising lock-on: content is ready somewhere else, come and look.
  "done-elsewhere": "ready",
  // A soft descending refusal: recoverable, retry or read the error.
  failed: "error",
  // A note gliding down: dismissed.
  cancelled: "droplet",
};

/** When several moments land in one snapshot, the one that matters most rings. */
const PRIORITY: readonly TaskMoment[] = [
  "failed",
  "done-here",
  "done-elsewhere",
  "cancelled",
  "sent",
];

export function loudestMoment(moments: readonly TaskMoment[]): TaskMoment | null {
  for (const moment of PRIORITY) if (moments.includes(moment)) return moment;
  return null;
}

/** A thread as the shell sees it: the root run, its newest turn and that turn's status. */
export interface ThreadState {
  readonly id: string;
  readonly latestRunId: string;
  readonly status: RunStatus;
}

const settled = (status: RunStatus) => status === "completed" || status === "failed";

/**
 * Moments between two shell snapshots. The first snapshot is only a baseline,
 * so a page load or a reconnect replay never rings, and a thread that first
 * appears already settled is silent too. A turn settles when its status leaves
 * the live states, or when a newer turn shows up already settled because it
 * started and finished between two snapshots.
 */
export function taskMoments(
  previous: ReadonlyMap<string, ThreadState> | null,
  next: readonly ThreadState[],
  openThreadId: string | null,
): TaskMoment[] {
  if (!previous) return [];
  const moments: TaskMoment[] = [];
  for (const thread of next) {
    const before = previous.get(thread.id);
    if (!before || !settled(thread.status)) continue;
    const newTurn = before.latestRunId !== thread.latestRunId;
    if (settled(before.status) && !newTurn) continue;
    if (thread.status === "failed") moments.push("failed");
    else moments.push(thread.id === openThreadId ? "done-here" : "done-elsewhere");
  }
  return moments;
}

/** The thread a session route shows, so its own turns ring as "here". */
export function openThreadIdFromPath(pathname: string | null | undefined): string | null {
  const match = pathname?.match(/^\/session\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** The person's choice, remembered per browser. On until they turn it off. */
export interface TaskSoundsPreference {
  enabled(): boolean;
  set(on: boolean): void;
  subscribe(listener: () => void): () => void;
}

const STORAGE_KEY = "useagent.task-sounds";

export function createTaskSoundsPreference(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
): TaskSoundsPreference {
  const listeners = new Set<() => void>();
  let enabled: boolean | null = null;
  const read = () => {
    try {
      return storage?.getItem(STORAGE_KEY) !== "off";
    } catch {
      return true;
    }
  };
  return {
    enabled: () => (enabled ??= read()),
    set(on) {
      enabled = on;
      try {
        storage?.setItem(STORAGE_KEY, on ? "on" : "off");
      } catch {
        // A blocked storage still keeps the choice for this page.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const taskSoundsPreference = createTaskSoundsPreference(
  typeof localStorage === "undefined" ? null : localStorage,
);

export interface TaskSoundPlayer {
  /** Ring one moment; false when sounds are off or one rang a moment ago. */
  moment(moment: TaskMoment): boolean;
  /** Ring the loudest of several moments, once. */
  moments(moments: readonly TaskMoment[]): boolean;
}

/** A burst of settles (a tab waking up, a reconnect) rings once, not once per thread. */
export const TASK_SOUND_GAP_MS = 1200;

export function createTaskSoundPlayer(
  play: (cue: TaskCue) => void,
  preference: TaskSoundsPreference,
  now: () => number = Date.now,
  gapMs = TASK_SOUND_GAP_MS,
): TaskSoundPlayer {
  let last = Number.NEGATIVE_INFINITY;
  const moment = (which: TaskMoment) => {
    if (!preference.enabled()) return false;
    const at = now();
    if (at - last < gapMs) return false;
    last = at;
    play(TASK_CUES[which]);
    return true;
  };
  return {
    moment,
    moments(all) {
      const loudest = loudestMoment(all);
      return loudest ? moment(loudest) : false;
    },
  };
}
