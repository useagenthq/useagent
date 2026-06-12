import { describe, expect, test } from "bun:test";
import {
  filterCommandEntries,
  findThreadMatches,
  rankThreads,
  threadActivityTimestamp,
  threadStatusPresentation,
} from "./thread-discovery";
import type { SidebarRun } from "./working-project-status";

function run(overrides: Partial<SidebarRun> & Pick<SidebarRun, "id">): SidebarRun {
  return {
    prompt: `Thread ${overrides.id}`,
    model: "claude-sonnet-5",
    engine: "opencode",
    status: "completed",
    summary: null,
    duration_ms: null,
    project_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    created_at: "2026-08-24T10:00:00Z",
    updated_at: "2026-08-24T10:00:00Z",
    ...overrides,
  } as SidebarRun;
}

describe("thread discovery search", () => {
  const commands = [{ label: "New thread" }, { label: "Settings" }];
  const runs = [
    run({ id: "auth", prompt: "Fix authentication", repos: ["acme/api"] }),
    run({
      id: "web",
      prompt: "Polish dashboard",
      repo_specs: [{ repo: "acme/web", branch: null }],
    }),
  ];

  test("matches loaded titles and repository identity", () => {
    expect(findThreadMatches(runs, "authentication").map((item) => item.id)).toEqual(["auth"]);
    expect(findThreadMatches(runs, "acme/web").map((item) => item.id)).toEqual(["web"]);
    expect(findThreadMatches([run({ id: "empty", prompt: "" })], "untitled")).toHaveLength(1);
  });

  test("returns no thread rows for blank or unmatched searches", () => {
    expect(findThreadMatches(runs, "")).toEqual([]);
    expect(findThreadMatches(runs, "does-not-exist")).toEqual([]);
  });

  test("static commands continue to coexist with thread results", () => {
    const threadRuns = [...runs, run({ id: "incident", prompt: "Thread incident review" })];
    expect(filterCommandEntries(commands, "thread")).toEqual([{ label: "New thread" }]);
    expect(findThreadMatches(threadRuns, "thread").map((item) => item.id)).toEqual(["incident"]);
    expect(filterCommandEntries(commands, "")).toEqual(commands);
  });
});

describe("thread discovery ordering and status", () => {
  test("ranks running, then queued, then remaining threads by activity", () => {
    const ranked = rankThreads([
      run({ id: "done-new", updated_at: "2026-08-24T12:00:00Z" }),
      run({ id: "queued", status: "queued", updated_at: "2026-08-20T12:00:00Z" }),
      run({ id: "running", status: "running", updated_at: "2026-08-19T12:00:00Z" }),
      run({ id: "done-old", updated_at: "2026-08-21T12:00:00Z" }),
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["running", "queued", "done-new", "done-old"]);
  });

  test("a realtime replacement changes status rank without mutating the prior snapshot", () => {
    const before = [run({ id: "a" }), run({ id: "b", updated_at: "2026-08-23T12:00:00Z" })];
    const after = before.map((item) =>
      item.id === "b" ? { ...item, status: "running" as const } : item,
    );
    expect(rankThreads(before).map((item) => item.id)).toEqual(["a", "b"]);
    expect(rankThreads(after).map((item) => item.id)).toEqual(["b", "a"]);
  });

  test("prefers latest-turn status and activity with a legacy fallback", () => {
    const latest = run({
      id: "latest",
      status: "completed",
      latest_status: "running",
      latest_created_at: "2026-08-24T11:00:00Z",
      latest_updated_at: "2026-08-24T12:00:00Z",
    });
    const legacy = run({
      id: "legacy",
      status: "queued",
      updated_at: "2026-08-24T10:00:00Z",
    });

    expect(rankThreads([legacy, latest]).map((item) => item.id)).toEqual(["latest", "legacy"]);
    expect(threadActivityTimestamp(latest)).toBe(Date.parse("2026-08-24T12:00:00Z"));
    expect(threadActivityTimestamp(legacy)).toBe(Date.parse("2026-08-24T10:00:00Z"));
  });

  test("deduplicates thread ids using the latest authoritative row", () => {
    const ranked = rankThreads([
      run({ id: "same", status: "running", updated_at: "2026-08-20T12:00:00Z" }),
      run({ id: "same", status: "completed", updated_at: "2026-08-24T12:00:00Z" }),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.status).toBe("completed");
  });

  test("running is green and announced; queued is amber; completion has no dot", () => {
    expect(threadStatusPresentation("running")).toMatchObject({
      label: "Running",
      dot: { tone: "success", pulse: true },
    });
    expect(threadStatusPresentation("queued")).toMatchObject({
      label: "Queued",
      dot: { tone: "away", hollow: true },
    });
    expect(threadStatusPresentation("completed").dot).toBeNull();
    expect(threadStatusPresentation("failed").dot?.tone).toBe("error");
  });
});
