import { expect, test } from "bun:test";
import { loadThreadView } from "./load-thread-view";
import type { ApiRun } from "./types";

const run = {
  id: "run-1", thread_id: "thread-1", org_id: "org-1", user_id: null,
  parent_run_id: null, prompt: "hello", model: "m", engine: "codex",
  status: "completed", summary: "done", duration_ms: null, engine_session_id: null,
  repo: null, repos: [], repo_specs: [],
  project_id: null, sandbox_id: null, child_session: false, resolved_resources: [],
  skill_id: null, skill_version: null, skill_content_hash: null, uploads: [],
  memory_scope: "org", created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(), steps: [],
} satisfies ApiRun;

test("loads a transcript while bot ownership is pending, then skips a home-only relationship", async () => {
  const calls: string[] = [];
  let resolveOwnership!: (applicable: boolean) => void;
  const ownership = new Promise<boolean>((resolve) => { resolveOwnership = resolve; });
  const view = loadThreadView("run-1", ownership, async (path) => {
    calls.push(path);
    return Response.json(path.endsWith("thread-outline") ? [] : { thread: [run] });
  });
  await Bun.sleep(0);
  expect(calls).toEqual(["/api/runs/run-1/thread-outline", "/api/runs/run-1?thread=1"]);
  resolveOwnership(false);
  expect((await view)?.relationshipHint).toBe("inapplicable");
  expect(calls).toHaveLength(2);
});

test("still loads the relationship for a normal thread after concurrent ownership resolution", async () => {
  const calls: string[] = [];
  const view = await loadThreadView("run-1", Promise.resolve(true), async (path) => {
    calls.push(path);
    if (path.includes("/relationship")) return new Response(null, { status: 404 });
    return Response.json(path.endsWith("thread-outline") ? [] : { thread: [run] });
  });
  expect(view?.thread[0]?.id).toBe("run-1");
  expect(view?.relationshipHint).toBe("legacy_or_off");
  expect(calls.at(-1)).toBe("/api/threads/thread-1/relationship");
});
