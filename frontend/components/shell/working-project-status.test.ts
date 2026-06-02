import { describe, expect, test } from "bun:test";

import {
  activeRunByRepo,
  explicitRunRepos,
  isSidebarActiveRun,
  runElapsedMs,
  runStatusLabel,
  type SidebarRun,
} from "./working-project-status";

const run = (overrides: Partial<SidebarRun>): SidebarRun => ({
  id: "run-1",
  prompt: "",
  model: "openai/gpt-5.6-luna",
  status: "running",
  summary: null,
  duration_ms: null,
  engine: "codex",
  repo: null,
  repos: [],
  repo_specs: [],
  created_at: "2026-08-17T00:00:00.000Z",
  updated_at: "2026-08-17T00:00:00.000Z",
  ...overrides,
});

describe("sidebar live status helpers", () => {
  test("uses explicit run repos only, never prompt keywords", () => {
    expect(
      explicitRunRepos(
        run({
          prompt: "Fix acme/new-skynet",
          repo: null,
          repos: [],
        }),
      ),
    ).toEqual([]);
    expect(explicitRunRepos(run({ repo: "acme/new-skynet" }))).toEqual(["acme/new-skynet"]);
    expect(explicitRunRepos(run({ repos: ["acme/a", 123, "", "acme/b"] as string[] }))).toEqual([
      "acme/a",
      "acme/b",
    ]);
  });

  test("maps the newest active run to each project from real repo fields", () => {
    const first = run({ id: "first", repos: ["acme/new-skynet"] });
    const second = run({ id: "second", repos: ["acme/new-skynet"] });
    const completed = run({ id: "done", status: "completed", repos: ["acme/done"] });

    const byRepo = activeRunByRepo([first, second, completed]);

    expect(byRepo.get("acme/new-skynet")?.id).toBe("first");
    expect(byRepo.has("acme/done")).toBe(false);
  });

  test("labels active statuses and computes elapsed from durable timestamps", () => {
    const started = run({ status: "running", created_at: "2026-08-17T00:00:00.000Z" });
    const queued = run({ status: "queued" });
    const done = run({ status: "completed", duration_ms: 42_000 });

    expect(isSidebarActiveRun(started)).toBe(true);
    expect(runStatusLabel(started)).toBe("Working");
    expect(runElapsedMs(started, Date.parse("2026-08-17T00:00:04.000Z"))).toBe(4_000);
    expect(runStatusLabel(queued)).toBe("Queued");
    expect(isSidebarActiveRun(done)).toBe(false);
    expect(runElapsedMs(done)).toBe(42_000);
  });
});
