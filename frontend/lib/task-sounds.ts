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
  readonly cancelled: boolean;
}

export interface TaskSoundSignal {
  readonly identity: string;
  readonly runId: string;
  readonly moment: TaskMoment;
}

const settled = (status: RunStatus) => status === "completed" || status === "failed";
const active = (status: RunStatus) => status === "queued" || status === "running";

/**
 * Moments between two shell snapshots. The first snapshot is only a baseline,
 * so a page load is silent. A reconnect revalidation compares against that
 * retained baseline and can recover one missed transition. A turn settles when
 * its status leaves the live states, or when a newer turn shows up already
 * settled because it started and finished between two snapshots.
 */
export function taskSoundSignals(
  previous: ReadonlyMap<string, ThreadState> | null,
  next: readonly ThreadState[],
  openThreadId: string | null,
): TaskSoundSignal[] {
  if (!previous) return [];
  const signals: TaskSoundSignal[] = [];
  for (const thread of next) {
    const before = previous.get(thread.id);
    if (!before) continue;
    const newTurn = before.latestRunId !== thread.latestRunId;
    if (thread.cancelled) {
      if (!before.cancelled || newTurn) {
        signals.push({
          identity: `run:${thread.latestRunId}:cancelled`,
          runId: thread.latestRunId,
          moment: "cancelled",
        });
      }
      continue;
    }
    if (!settled(thread.status) || (settled(before.status) && !newTurn)) continue;
    signals.push({
      identity: `run:${thread.latestRunId}:settled`,
      runId: thread.latestRunId,
      moment:
        thread.status === "failed"
          ? "failed"
          : thread.id === openThreadId
            ? "done-here"
            : "done-elsewhere",
    });
  }
  return signals;
}

export function taskMoments(
  previous: ReadonlyMap<string, ThreadState> | null,
  next: readonly ThreadState[],
  openThreadId: string | null,
): TaskMoment[] {
  return taskSoundSignals(previous, next, openThreadId).map((signal) => signal.moment);
}

/** Active runs displaced by a newer turn need an exact read; the latest-thread
 * projection can no longer reveal how the displaced run settled. */
export function overtakenActiveRuns(
  previous: ReadonlyMap<string, ThreadState>,
  next: readonly ThreadState[],
): ThreadState[] {
  const nextByThread = new Map(next.map((thread) => [thread.id, thread]));
  return [...previous.values()].filter(
    (thread) =>
      active(thread.status) &&
      !thread.cancelled &&
      nextByThread.get(thread.id)?.latestRunId !== thread.latestRunId,
  );
}

/** Coalesce duplicate exact-run reads without losing a transition that lands
 * during an in-flight read. Each burst gets at most one immediate trailing read;
 * a later dirty mark schedules another awaited burst instead of busy-looping. */
export function createTaskSoundReconciler(
  read: (before: ThreadState) => Promise<void>,
): (before: ThreadState) => Promise<void> {
  interface Entry {
    before: ThreadState;
    dirty: boolean;
    promise: Promise<void> | null;
  }
  const entries = new Map<string, Entry>();
  const reconcile = (before: ThreadState): Promise<void> => {
    const key = before.latestRunId;
    const existing = entries.get(key);
    if (existing) {
      existing.before = before;
      existing.dirty = true;
      return existing.promise ?? Promise.resolve();
    }
    const entry: Entry = { before, dirty: false, promise: null };
    entries.set(key, entry);
    entry.promise = (async () => {
      let rerun: ThreadState | null = null;
      try {
        for (let pass = 0; pass < 2; pass++) {
          entry.dirty = false;
          await read(entry.before);
          if (!entry.dirty) break;
        }
        rerun = entry.dirty ? entry.before : null;
      } catch {
        // A signal arriving during a failed read still requires a fresh tail.
        rerun = entry.dirty ? entry.before : null;
      } finally {
        entries.delete(key);
      }
      if (rerun) await reconcile(rerun);
    })();
    return entry.promise;
  };
  return reconcile;
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
  sync(storedValue: string | null): void;
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
    sync(storedValue) {
      const next = storedValue !== "off";
      if (enabled === next) return;
      enabled = next;
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

export function safeTaskSoundStorage(
  host: { readonly localStorage?: Storage } = globalThis,
): Storage | null {
  try {
    return host.localStorage ?? null;
  } catch {
    return null;
  }
}

const browserStorage = typeof window === "undefined" ? null : safeTaskSoundStorage();
export const taskSoundsPreference = createTaskSoundsPreference(browserStorage);

try {
  globalThis.addEventListener?.("storage", (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) taskSoundsPreference.sync(event.newValue);
  });
} catch {
  // Storage events are an enhancement; the local toggle still works without them.
}

export interface TaskSoundPlayer {
  /** Ring one moment; false when sounds are off or one rang a moment ago. */
  moment(moment: TaskMoment, identity?: string): Promise<boolean>;
  /** Ring the loudest of several moments, once. */
  moments(moments: readonly TaskMoment[], identity?: string): Promise<boolean>;
  /** Ring the loudest exact lifecycle signal, once across browser tabs. */
  signals(signals: readonly TaskSoundSignal[]): Promise<boolean>;
}

/** A burst of settles (a tab waking up, a reconnect) rings once, not once per thread. */
export const TASK_SOUND_GAP_MS = 1200;

export interface TaskSoundAdmission {
  readonly play: boolean;
  readonly retryAfterMs: number;
}

export type TaskSoundClaim = (
  identity: string,
  moment: TaskMoment,
  at: number,
  gapMs: number,
) => TaskSoundAdmission | Promise<TaskSoundAdmission>;

interface TaskSoundLockManager {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive" },
    callback: () => T | PromiseLike<T>,
  ): Promise<T>;
}

const CLAIMS_STORAGE_KEY = "useagent.task-sound-identities";
const MAX_STORED_IDENTITIES = 512;

interface TaskSoundClaimState {
  readonly identities: readonly string[];
  readonly lastPlayedAt: number | null;
}

const ignored = (): TaskSoundAdmission => ({ play: false, retryAfterMs: 0 });

function admitFromState(
  state: TaskSoundClaimState,
  identity: string,
  moment: TaskMoment,
  at: number,
  gapMs: number,
): { readonly admission: TaskSoundAdmission; readonly next: TaskSoundClaimState | null } {
  if (state.identities.includes(identity)) return { admission: ignored(), next: null };
  if (state.lastPlayedAt !== null) {
    const remaining = gapMs - Math.max(0, at - state.lastPlayedAt);
    if (remaining > 0) {
      const lifecycleTerminal = identity.startsWith("run:") && moment !== "sent";
      return {
        admission: lifecycleTerminal ? { play: false, retryAfterMs: remaining } : ignored(),
        next: null,
      };
    }
  }
  return {
    admission: { play: true, retryAfterMs: 0 },
    next: {
      identities: [...state.identities.slice(-(MAX_STORED_IDENTITIES - 1)), identity],
      lastPlayedAt: at,
    },
  };
}

function readClaimState(storage: Pick<Storage, "getItem" | "setItem">): TaskSoundClaimState {
  const raw = storage.getItem(CLAIMS_STORAGE_KEY);
  const parsed = raw ? JSON.parse(raw) : null;
  if (Array.isArray(parsed)) {
    return {
      identities: parsed
        .filter((value): value is string => typeof value === "string")
        .slice(-MAX_STORED_IDENTITIES),
      lastPlayedAt: null,
    };
  }
  if (!parsed || typeof parsed !== "object") return { identities: [], lastPlayedAt: null };
  const value = parsed as { identities?: unknown; lastPlayedAt?: unknown };
  return {
    identities: Array.isArray(value.identities)
      ? value.identities
          .filter((item): item is string => typeof item === "string")
          .slice(-MAX_STORED_IDENTITIES)
      : [],
    lastPlayedAt:
      typeof value.lastPlayedAt === "number" && Number.isFinite(value.lastPlayedAt)
        ? value.lastPlayedAt
        : null,
  };
}

function admitStoredIdentity(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  identity: string,
  moment: TaskMoment,
  at: number,
  gapMs: number,
): TaskSoundAdmission | null {
  if (!storage) return null;
  try {
    const { admission, next } = admitFromState(
      readClaimState(storage),
      identity,
      moment,
      at,
      gapMs,
    );
    if (next) storage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify(next));
    return admission;
  } catch {
    return null;
  }
}

/** Exact browser-wide dedupe. Web Locks serializes the shared ledger; browsers
 * without it ring only in the focused tab so concurrent tabs cannot all play. */
export function createBrowserTaskSoundClaim(options: {
  readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  readonly locks: TaskSoundLockManager | null;
  readonly hasFocus: () => boolean;
}): TaskSoundClaim {
  let localState: TaskSoundClaimState = { identities: [], lastPlayedAt: null };
  const admitHere = (identity: string, moment: TaskMoment, at: number, gapMs: number) => {
    const result = admitFromState(localState, identity, moment, at, gapMs);
    if (result.next) localState = result.next;
    return result.admission;
  };
  const admit = (identity: string, moment: TaskMoment, at: number, gapMs: number) =>
    admitStoredIdentity(options.storage, identity, moment, at, gapMs) ??
    admitHere(identity, moment, at, gapMs);

  return async (identity, moment, at, gapMs) => {
    try {
      if (options.locks) {
        return await options.locks.request(
          "useagent.task-sound-claim",
          { mode: "exclusive" },
          () => (options.hasFocus() ? admit(identity, moment, at, gapMs) : ignored()),
        );
      }
      if (!options.hasFocus()) return ignored();
      return admit(identity, moment, at, gapMs);
    } catch {
      return options.hasFocus() ? admitHere(identity, moment, at, gapMs) : ignored();
    }
  };
}

export function browserTaskSoundClaim(): TaskSoundClaim {
  let locks: TaskSoundLockManager | null = null;
  try {
    locks = navigator.locks as TaskSoundLockManager;
  } catch {
    // The focused-tab fallback below covers blocked or absent Navigator Locks.
  }
  return createBrowserTaskSoundClaim({
    storage: browserStorage,
    locks,
    hasFocus: () => {
      try {
        return typeof document === "undefined" || document.hasFocus();
      } catch {
        return false;
      }
    },
  });
}

export function createTaskSoundPlayer(
  play: (cue: TaskCue) => void | Promise<void>,
  preference: TaskSoundsPreference,
  now: () => number = Date.now,
  gapMs = TASK_SOUND_GAP_MS,
  claim: TaskSoundClaim = () => ({ play: true, retryAfterMs: 0 }),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): TaskSoundPlayer {
  let last = Number.NEGATIVE_INFINITY;
  const moment = async (which: TaskMoment, identity?: string) => {
    try {
      if (!preference.enabled()) return false;
      if (identity) {
        for (;;) {
          if (!preference.enabled()) return false;
          const admission = await claim(identity, which, now(), gapMs);
          if (admission.play) break;
          if (admission.retryAfterMs <= 0) return false;
          await sleep(admission.retryAfterMs);
        }
      } else {
        const at = now();
        if (at - last < gapMs) return false;
        last = at;
      }
      await play(TASK_CUES[which]);
      return true;
    } catch {
      return false;
    }
  };
  return {
    moment,
    moments(all, identity) {
      const loudest = loudestMoment(all);
      return loudest ? moment(loudest, identity) : Promise.resolve(false);
    },
    signals(all) {
      const loudest = loudestMoment(all.map((signal) => signal.moment));
      const signal = loudest ? all.find((candidate) => candidate.moment === loudest) : null;
      return signal ? moment(signal.moment, signal.identity) : Promise.resolve(false);
    },
  };
}
