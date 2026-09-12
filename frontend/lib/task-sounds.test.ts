import { describe, expect, test } from "bun:test";
import type { RunStatus } from "@useagent/agent-client/wire";
import {
  createBrowserTaskSoundClaim,
  createTaskSoundPlayer,
  createTaskSoundReconciler,
  createTaskSoundsPreference,
  loudestMoment,
  openThreadIdFromPath,
  overtakenActiveRuns,
  safeTaskSoundStorage,
  type TaskCue,
  type TaskSoundSignal,
  type ThreadState,
  taskMoments,
  taskSoundSignals,
} from "./task-sounds";

const thread = (
  id: string,
  status: RunStatus,
  latestRunId = id,
  cancelled = false,
): ThreadState => ({
  id,
  latestRunId,
  status,
  cancelled,
});
const snapshot = (...threads: ThreadState[]) => new Map(threads.map((t) => [t.id, t]));

describe("taskMoments", () => {
  test("the first snapshot is a baseline and never rings", () => {
    expect(taskMoments(null, [thread("a", "completed")], "a")).toEqual([]);
    expect(taskSoundSignals(null, [thread("b", "failed", "run-b", true)], "b")).toEqual([]);
  });

  test("a turn finishing in the open thread is done-here, elsewhere is done-elsewhere", () => {
    const before = snapshot(thread("a", "running"), thread("b", "queued"));
    const after = [thread("a", "completed"), thread("b", "completed")];
    expect(taskMoments(before, after, "a")).toEqual(["done-here", "done-elsewhere"]);
  });

  test("a failed turn is failed wherever it is", () => {
    const before = snapshot(thread("a", "running"));
    expect(taskMoments(before, [thread("a", "failed")], "a")).toEqual(["failed"]);
    expect(taskMoments(before, [thread("a", "failed")], null)).toEqual(["failed"]);
  });

  test("a reply that started and finished between two snapshots still settles", () => {
    const before = snapshot(thread("a", "completed", "turn-1"));
    expect(taskMoments(before, [thread("a", "completed", "turn-2")], null)).toEqual([
      "done-elsewhere",
    ]);
  });

  test("a thread that first appears already settled is silent", () => {
    expect(taskMoments(snapshot(), [thread("a", "completed")], "a")).toEqual([]);
  });

  test("a reconnect snapshot catches one missed completion without replaying it", () => {
    const before = snapshot(thread("a", "running", "run-a"));
    const after = [thread("a", "completed", "run-a")];
    expect(taskSoundSignals(null, after, "a")).toEqual([]);
    expect(taskSoundSignals(before, after, "a")).toEqual([
      {
        identity: "run:run-a:settled",
        runId: "run-a",
        moment: "done-here",
      },
    ]);
    expect(taskSoundSignals(snapshot(...after), after, "a")).toEqual([]);
  });

  test("a reconnect uses durable cancel intent for one cancel cue instead of an error", () => {
    expect(
      taskSoundSignals(
        snapshot(thread("a", "running", "run-a")),
        [thread("a", "failed", "run-a", true)],
        "a",
      ),
    ).toEqual([
      {
        identity: "run:run-a:cancelled",
        runId: "run-a",
        moment: "cancelled",
      },
    ]);
  });

  test("an already-known cancellation stays silent when its failed snapshot arrives", () => {
    const before = snapshot(thread("a", "running", "run-a", true));
    expect(taskSoundSignals(before, [thread("a", "failed", "run-a", true)], "a")).toEqual([]);
  });

  test("identifies an active run overtaken by a newer turn", () => {
    const before = snapshot(thread("a", "running", "run-a"));
    const next = [thread("a", "running", "run-b")];
    const [overtaken] = overtakenActiveRuns(before, next);
    if (!overtaken) throw new Error("expected run-a to be overtaken");
    expect(overtaken).toEqual(thread("a", "running", "run-a"));
    expect(taskSoundSignals(before, next, "a")).toEqual([]);
    expect(taskSoundSignals(snapshot(overtaken), [thread("a", "completed", "run-a")], "a")).toEqual(
      [
        {
          identity: "run:run-a:settled",
          runId: "run-a",
          moment: "done-here",
        },
      ],
    );
  });

  test("a dirty in-flight reconcile performs one fresh tail read after success or failure", async () => {
    for (const firstFails of [false, true]) {
      const before = thread("a", "running", "run-a");
      let releaseFirst!: () => void;
      const firstRead = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const states = [thread("a", "running", "run-a"), thread("a", "completed", "run-a")];
      const signals: TaskSoundSignal[] = [];
      let reads = 0;
      const reconcile = createTaskSoundReconciler(async (baseline) => {
        const next = states[reads++];
        if (reads === 1) {
          await firstRead;
          if (firstFails) throw new Error("first read unavailable");
        }
        if (next) signals.push(...taskSoundSignals(snapshot(baseline), [next], "a"));
      });

      const initial = reconcile(before);
      const dirty = reconcile(before);
      releaseFirst();
      await Promise.all([initial, dirty]);

      expect(reads).toBe(2);
      expect(signals).toEqual([
        {
          identity: "run:run-a:settled",
          runId: "run-a",
          moment: "done-here",
        },
      ]);
    }
  });

  test("live turns and unchanged settled turns are silent", () => {
    const before = snapshot(thread("a", "queued"), thread("b", "completed"));
    expect(taskMoments(before, [thread("a", "running"), thread("b", "completed")], "a")).toEqual(
      [],
    );
  });
});

test("loudestMoment ranks a failure over a finish and a finish here over one elsewhere", () => {
  expect(loudestMoment(["done-elsewhere", "failed", "done-here"])).toBe("failed");
  expect(loudestMoment(["done-elsewhere", "done-here"])).toBe("done-here");
  expect(loudestMoment([])).toBeNull();
});

test("openThreadIdFromPath reads the session route only", () => {
  expect(openThreadIdFromPath("/session/abc-123")).toBe("abc-123");
  expect(openThreadIdFromPath("/session/abc-123?tab=files")).toBe("abc-123");
  expect(openThreadIdFromPath("/bots/abc-123")).toBeNull();
  expect(openThreadIdFromPath(null)).toBeNull();
});

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe("task sounds preference", () => {
  test("is on until turned off, and remembers the choice", () => {
    const storage = fakeStorage();
    const preference = createTaskSoundsPreference(storage);
    expect(preference.enabled()).toBe(true);
    preference.set(false);
    expect(preference.enabled()).toBe(false);
    expect(storage.values.get("useagent.task-sounds")).toBe("off");
    expect(createTaskSoundsPreference(storage).enabled()).toBe(false);
  });

  test("notifies subscribers and survives a blocked storage", () => {
    const preference = createTaskSoundsPreference({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    let notified = 0;
    const unsubscribe = preference.subscribe(() => notified++);
    expect(preference.enabled()).toBe(true);
    preference.set(false);
    expect(preference.enabled()).toBe(false);
    expect(notified).toBe(1);
    unsubscribe();
    preference.set(true);
    expect(notified).toBe(1);
  });

  test("syncs a choice made in another tab", () => {
    const storage = fakeStorage();
    const first = createTaskSoundsPreference(storage);
    const second = createTaskSoundsPreference(storage);
    let notified = 0;
    second.subscribe(() => notified++);

    first.set(false);
    second.sync(storage.values.get("useagent.task-sounds") ?? null);

    expect(second.enabled()).toBe(false);
    expect(notified).toBe(1);
  });

  test("a blocked global storage getter is safe during module initialization", () => {
    const host = {} as { readonly localStorage?: Storage };
    Object.defineProperty(host, "localStorage", {
      get() {
        throw new Error("blocked");
      },
    });
    expect(safeTaskSoundStorage(host)).toBeNull();
  });
});

describe("task sound player", () => {
  function player(enabled = true) {
    const played: TaskCue[] = [];
    let clock = 0;
    const preference = createTaskSoundsPreference(
      fakeStorage({ "useagent.task-sounds": enabled ? "on" : "off" }),
    );
    const play = createTaskSoundPlayer(
      (cue) => played.push(cue),
      preference,
      () => clock,
      1000,
    );
    return { played, play, tick: (ms: number) => (clock += ms) };
  }

  test("maps every moment to its cue", async () => {
    const { played, play, tick } = player();
    for (const moment of ["sent", "done-here", "done-elsewhere", "failed", "cancelled"] as const) {
      expect(await play.moment(moment)).toBe(true);
      tick(1000);
    }
    expect(played).toEqual(["loading", "success", "ready", "error", "droplet"]);
  });

  test("a burst rings once, with the loudest moment", async () => {
    const { played, play, tick } = player();
    expect(await play.moments(["done-elsewhere", "done-elsewhere", "failed"])).toBe(true);
    expect(await play.moment("done-here")).toBe(false);
    tick(999);
    expect(await play.moment("done-here")).toBe(false);
    tick(1);
    expect(await play.moment("done-here")).toBe(true);
    expect(played).toEqual(["error", "success"]);
  });

  test("stays silent when sounds are off", async () => {
    const { played, play } = player(false);
    expect(await play.moment("failed")).toBe(false);
    expect(await play.moments(["done-here"])).toBe(false);
    expect(played).toEqual([]);
  });

  test("sync and async audio failures stay optional", async () => {
    const preference = createTaskSoundsPreference(fakeStorage());
    const syncFailure = createTaskSoundPlayer(() => {
      throw new Error("audio blocked");
    }, preference);
    const asyncFailure = createTaskSoundPlayer(
      () => Promise.reject(new Error("audio rejected")),
      preference,
    );
    expect(await syncFailure.moment("sent")).toBe(false);
    expect(await asyncFailure.moment("sent")).toBe(false);
  });

  test("two tabs claim an exact run moment once while different runs still ring", async () => {
    const storage = fakeStorage();
    const locks = {
      async request<T>(
        _name: string,
        _options: { readonly mode: "exclusive" },
        callback: () => T | PromiseLike<T>,
      ): Promise<T> {
        return callback();
      },
    };
    const backgroundClaim = createBrowserTaskSoundClaim({ storage, locks, hasFocus: () => false });
    const focusedClaim = createBrowserTaskSoundClaim({ storage, locks, hasFocus: () => true });

    expect(
      await Promise.all([
        backgroundClaim("run:one:settled", "done-elsewhere", 0, 1000),
        focusedClaim("run:one:settled", "done-here", 0, 1000),
      ]),
    ).toEqual([
      { play: false, retryAfterMs: 0 },
      { play: true, retryAfterMs: 0 },
    ]);
    expect(await focusedClaim("run:two:settled", "done-here", 1000, 1000)).toEqual({
      play: true,
      retryAfterMs: 0,
    });
  });

  test("different tab paths use the focused tab's cue for the same exact settlement", async () => {
    const storage = fakeStorage();
    const locks = {
      async request<T>(
        _name: string,
        _options: { readonly mode: "exclusive" },
        callback: () => T | PromiseLike<T>,
      ): Promise<T> {
        return callback();
      },
    };
    const backgroundCues: TaskCue[] = [];
    const focusedCues: TaskCue[] = [];
    const preference = createTaskSoundsPreference(fakeStorage());
    const background = createTaskSoundPlayer(
      (cue) => backgroundCues.push(cue),
      preference,
      () => 0,
      1000,
      createBrowserTaskSoundClaim({ storage, locks, hasFocus: () => false }),
    );
    const focused = createTaskSoundPlayer(
      (cue) => focusedCues.push(cue),
      preference,
      () => 0,
      1000,
      createBrowserTaskSoundClaim({ storage, locks, hasFocus: () => true }),
    );
    const identity = "run:one:settled";
    expect(
      await Promise.all([
        background.signals([{ identity, runId: "one", moment: "done-elsewhere" }]),
        focused.signals([{ identity, runId: "one", moment: "done-here" }]),
      ]),
    ).toEqual([false, true]);
    expect(backgroundCues).toEqual([]);
    expect(focusedCues).toEqual(["success"]);
  });

  test("without browser locks only the focused tab may claim", async () => {
    const storage = fakeStorage();
    const background = createBrowserTaskSoundClaim({
      storage,
      locks: null,
      hasFocus: () => false,
    });
    const focused = createBrowserTaskSoundClaim({
      storage,
      locks: null,
      hasFocus: () => true,
    });
    expect(await background("run:one:cancelled", "cancelled", 0, 1000)).toEqual({
      play: false,
      retryAfterMs: 0,
    });
    expect(await focused("run:one:cancelled", "cancelled", 0, 1000)).toEqual({
      play: true,
      retryAfterMs: 0,
    });
    expect(await focused("run:one:cancelled", "cancelled", 1000, 1000)).toEqual({
      play: false,
      retryAfterMs: 0,
    });
  });

  test("a second tab's terminal cue waits out the shared browser gap instead of being consumed", async () => {
    const storage = fakeStorage();
    const locks = {
      async request<T>(
        _name: string,
        _options: { readonly mode: "exclusive" },
        callback: () => T | PromiseLike<T>,
      ): Promise<T> {
        return callback();
      },
    };
    let clock = 0;
    const played: TaskCue[] = [];
    const first = createTaskSoundPlayer(
      (cue) => played.push(cue),
      createTaskSoundsPreference(fakeStorage()),
      () => clock,
      1000,
      createBrowserTaskSoundClaim({ storage, locks, hasFocus: () => true }),
    );
    const second = createTaskSoundPlayer(
      (cue) => played.push(cue),
      createTaskSoundsPreference(fakeStorage()),
      () => clock,
      1000,
      createBrowserTaskSoundClaim({ storage, locks, hasFocus: () => true }),
      async (ms) => {
        clock += ms;
      },
    );

    expect(await first.moment("sent", "run:one:sent")).toBe(true);
    const toggleClaim = createBrowserTaskSoundClaim({ storage, locks, hasFocus: () => true });
    expect(await toggleClaim("toggle:one", "done-here", 100, 1000)).toEqual({
      play: false,
      retryAfterMs: 0,
    });
    expect(await second.moment("failed", "run:one:settled")).toBe(true);
    expect(clock).toBe(1000);
    expect(played).toEqual(["loading", "error"]);
  });

  test("the cross-tab identity ledger stays bounded", async () => {
    const storage = fakeStorage();
    const claim = createBrowserTaskSoundClaim({ storage, locks: null, hasFocus: () => true });
    for (let index = 0; index < 513; index++) {
      expect(await claim(`run:${index}:settled`, "done-here", index * 1000, 1000)).toEqual({
        play: true,
        retryAfterMs: 0,
      });
    }
    const stored = storage.values.get("useagent.task-sound-identities");
    expect(JSON.parse(stored ?? "{}").identities).toHaveLength(512);
  });
});
