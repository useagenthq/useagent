import { describe, expect, test } from "bun:test";
import type { RunStatus } from "@useagent/agent-client/wire";
import {
  createTaskSoundPlayer,
  createTaskSoundsPreference,
  loudestMoment,
  openThreadIdFromPath,
  type TaskCue,
  type ThreadState,
  taskMoments,
} from "./task-sounds";

const thread = (id: string, status: RunStatus, latestRunId = id): ThreadState => ({
  id,
  latestRunId,
  status,
});
const snapshot = (...threads: ThreadState[]) => new Map(threads.map((t) => [t.id, t]));

describe("taskMoments", () => {
  test("the first snapshot is a baseline and never rings", () => {
    expect(taskMoments(null, [thread("a", "completed")], "a")).toEqual([]);
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

  test("maps every moment to its cue", () => {
    const { played, play, tick } = player();
    for (const moment of ["sent", "done-here", "done-elsewhere", "failed", "cancelled"] as const) {
      expect(play.moment(moment)).toBe(true);
      tick(1000);
    }
    expect(played).toEqual(["loading", "success", "ready", "error", "droplet"]);
  });

  test("a burst rings once, with the loudest moment", () => {
    const { played, play, tick } = player();
    expect(play.moments(["done-elsewhere", "done-elsewhere", "failed"])).toBe(true);
    expect(play.moment("done-here")).toBe(false);
    tick(999);
    expect(play.moment("done-here")).toBe(false);
    tick(1);
    expect(play.moment("done-here")).toBe(true);
    expect(played).toEqual(["error", "success"]);
  });

  test("stays silent when sounds are off", () => {
    const { played, play } = player(false);
    expect(play.moment("failed")).toBe(false);
    expect(play.moments(["done-here"])).toBe(false);
    expect(played).toEqual([]);
  });
});
