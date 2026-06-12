// Fleet dispatch gate: the authenticated bearer header + faithful run body, the
// bounded-concurrency fan-out with partial-failure isolation, the poll-until-settled
// loop (deterministic clock), the in-thread QC reply, and the VERDICT parser. All
// deterministic - fetch and the clock are injected, no live calls, no real timers.

import { describe, expect, test } from "bun:test";
import type { FetchLike, ResponseLike } from "../src/api";
import {
  createFleetClient,
  fleetRunUrl,
  MAX_DURABLE_BATCH_TASKS,
  MAX_FLEET_CONCURRENCY,
  MAX_FLEET_TASKS,
  parseVerdict,
  type DispatchOutcome,
} from "../src/fleet";

function jsonResponse(status: number, body: unknown): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A complete, decode-valid ApiRun row (getThread validates every field). */
function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run_1",
    org_id: "org-1",
    user_id: "user-1",
    prompt: "hello",
    model: "anthropic/claude-sonnet-5",
    engine: "opencode",
    status: "running",
    summary: null,
    duration_ms: null,
    parent_run_id: null,
    child_session: false,
    thread_id: "run_1",
    engine_session_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    resolved_resources: [],
    memory_scope: "org",
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    steps: [],
    ...overrides,
  };
}

const CONFIG = { baseUrl: "https://fleet.test", apiKey: "uak_secret" };

describe("createFleetClient.dispatch", () => {
  test("sends Bearer auth + the run body and returns the run + web url", async () => {
    const calls: { url: string; init?: Parameters<FetchLike>[1] }[] = [];
    const fetchStub: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(201, { id: "run_42", status: "queued" });
    };
    const client = createFleetClient({ ...CONFIG, fetch: fetchStub });
    const run = await client.dispatch({
      prompt: "do the thing",
      engine: "codex",
      model: "openai/gpt-5.6",
      repos: ["acme/web"],
      idempotencyKey: "k-1",
    });

    expect(run).toEqual({
      runId: "run_42",
      status: "queued",
      url: "https://fleet.test/session/run_42",
    });
    expect(calls[0]!.url).toBe("https://fleet.test/api/runs");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers?.Authorization).toBe("Bearer uak_secret");
    expect(calls[0]!.init?.headers?.["Idempotency-Key"]).toBe("k-1");
    expect(JSON.parse(calls[0]!.init!.body!)).toEqual({
      prompt: "do the thing",
      engine: "codex",
      model: "openai/gpt-5.6",
      repos: ["acme/web"],
    });
  });

  test("omits optional fields when the task carries only a prompt", async () => {
    let body = "";
    const client = createFleetClient({
      ...CONFIG,
      fetch: async (_u, init) => {
        body = init!.body!;
        return jsonResponse(201, { id: "r", status: "queued" });
      },
    });
    await client.dispatch({ prompt: "bare" });
    expect(JSON.parse(body)).toEqual({ prompt: "bare" });
  });
});

describe("createFleetClient.dispatchMany", () => {
  test("respects the concurrency bound", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchStub: FetchLike = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return jsonResponse(201, { id: "r", status: "queued" });
    };
    const client = createFleetClient({ ...CONFIG, fetch: fetchStub });
    const tasks = Array.from({ length: 6 }, (_, i) => ({ prompt: `t${i}` }));
    const out = await client.dispatchMany(tasks, { concurrency: 2 });

    expect(out).toHaveLength(6);
    expect(out.every((o) => o.ok)).toBe(true);
    expect(maxInFlight).toBe(2);
  });

  test("isolates a per-task failure without sinking the batch", async () => {
    const fetchStub: FetchLike = async (_u, init) => {
      const parsed = JSON.parse(init!.body!) as { prompt: string };
      if (parsed.prompt.includes("boom")) return jsonResponse(500, { error: "nope" });
      return jsonResponse(201, { id: `ok_${parsed.prompt}`, status: "queued" });
    };
    const client = createFleetClient({ ...CONFIG, fetch: fetchStub });
    const out = await client.dispatchMany([
      { prompt: "a" },
      { prompt: "boom" },
      { prompt: "c" },
    ]);

    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
    const failed = out[1] as Extract<DispatchOutcome, { ok: false }>;
    expect(failed.error).toContain("HTTP 500");
    expect(failed.task.prompt).toBe("boom");
    const first = out[0] as Extract<DispatchOutcome, { ok: true }>;
    expect(first.run.runId).toBe("ok_a");
  });

  test("applies idempotencyPrefix per index but never overrides an explicit key", async () => {
    const keys: (string | undefined)[] = [];
    const client = createFleetClient({
      ...CONFIG,
      fetch: async (_u, init) => {
        keys.push(init?.headers?.["Idempotency-Key"]);
        return jsonResponse(201, { id: "r", status: "queued" });
      },
    });
    await client.dispatchMany(
      [{ prompt: "a" }, { prompt: "b", idempotencyKey: "explicit" }, { prompt: "c" }],
      { concurrency: 1, idempotencyPrefix: "batch" },
    );
    expect(keys).toEqual(["batch-0", "explicit", "batch-2"]);
  });

  test("rejects oversized batches and invalid concurrency before dispatch", async () => {
    const client = createFleetClient({ ...CONFIG, fetch: async () => jsonResponse(201, {}) });
    const tooMany = Array.from({ length: MAX_FLEET_TASKS + 1 }, (_, index) => ({
      prompt: `task-${index}`,
    }));
    await expect(client.dispatchMany(tooMany)).rejects.toThrow(
      `at most ${MAX_FLEET_TASKS} tasks`,
    );
    await expect(
      client.dispatchMany([{ prompt: "one" }], { concurrency: MAX_FLEET_CONCURRENCY + 1 }),
    ).rejects.toThrow(`between 1 and ${MAX_FLEET_CONCURRENCY}`);
  });
});

describe("createFleetClient durable batches", () => {
  test("dispatchBatch accepts the ordered task set in one authenticated request", async () => {
    const calls: { url: string; init?: Parameters<FetchLike>[1] }[] = [];
    const client = createFleetClient({
      ...CONFIG,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(201, {
          batch_id: "batch_1",
          replayed: false,
          status: "running",
          created_at: "2026-08-28T00:00:00.000Z",
          runs: [
            {
              ordinal: 1,
              run_id: "run_b",
              status: "queued",
              queue: { state: "queued", reason: "org_limit" },
            },
            {
              ordinal: 0,
              run_id: "run_a",
              status: "running",
              queue: { state: "running", reason: null },
            },
          ],
        });
      },
    });

    const batch = await client.dispatchBatch(
      [
        { prompt: "a", engine: "codex", repos: ["acme/web"] },
        { prompt: "b", model: "openai/gpt-5.6" },
      ],
      { idempotencyKey: "fleet-demo-1" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://fleet.test/api/fleet/batches");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers?.Authorization).toBe("Bearer uak_secret");
    expect(calls[0]!.init?.headers?.["Idempotency-Key"]).toBe("fleet-demo-1");
    expect(JSON.parse(calls[0]!.init!.body!)).toEqual({
      tasks: [
        { prompt: "a", engine: "codex", repos: ["acme/web"] },
        { prompt: "b", model: "openai/gpt-5.6" },
      ],
    });
    expect(batch).toEqual({
      batchId: "batch_1",
      status: "running",
      createdAt: "2026-08-28T00:00:00.000Z",
      replayed: false,
      runs: [
        {
          ordinal: 0,
          runId: "run_a",
          status: "running",
          queue: { state: "running", reason: null },
          url: "https://fleet.test/session/run_a",
        },
        {
          ordinal: 1,
          runId: "run_b",
          status: "queued",
          queue: { state: "queued", reason: "org_limit" },
          url: "https://fleet.test/session/run_b",
        },
      ],
    });
  });

  test("getBatch reads current ordered queue metadata", async () => {
    let called = "";
    const client = createFleetClient({
      ...CONFIG,
      fetch: async (url) => {
        called = url;
        return jsonResponse(200, {
          batch_id: "batch/1",
          replayed: false,
          status: "completed",
          created_at: "2026-08-28T00:00:00.000Z",
          runs: [
            {
              ordinal: 0,
              run_id: "run_a",
              status: "completed",
              queue: { state: "terminal", reason: null },
            },
          ],
        });
      },
    });

    const batch = await client.getBatch("batch/1");
    expect(called).toBe("https://fleet.test/api/fleet/batches/batch%2F1");
    expect(batch.replayed).toBe(false);
    expect(batch.runs[0]).toMatchObject({
      ordinal: 0,
      runId: "run_a",
      status: "completed",
      queue: { state: "terminal", reason: null },
    });
  });

  test("marks an idempotent POST replay from the backend's 200 response", async () => {
    const client = createFleetClient({
      ...CONFIG,
      fetch: async () => jsonResponse(200, {
        batch_id: "batch_1",
        replayed: true,
        status: "queued",
        created_at: "2026-08-28T00:00:00.000Z",
        runs: [
          {
            ordinal: 0,
            run_id: "run_a",
            status: "queued",
            queue: null,
          },
        ],
      }),
    });

    const batch = await client.dispatchBatch([{ prompt: "a" }], { idempotencyKey: "same" });
    expect(batch.replayed).toBe(true);
    expect(batch.runs[0]!.queue).toEqual({ state: null, reason: null });
  });

  test("rejects empty, oversized, unkeyed, and malformed batches before use", async () => {
    let calls = 0;
    const client = createFleetClient({
      ...CONFIG,
      fetch: async () => {
        calls++;
        return jsonResponse(201, {});
      },
    });
    await expect(client.dispatchBatch([], { idempotencyKey: "k" })).rejects.toThrow("between 1 and 20");
    await expect(
      client.dispatchBatch(
        Array.from({ length: MAX_DURABLE_BATCH_TASKS + 1 }, (_, index) => ({ prompt: `t${index}` })),
        { idempotencyKey: "k" },
      ),
    ).rejects.toThrow("between 1 and 20");
    await expect(client.dispatchBatch([{ prompt: "a" }], { idempotencyKey: "" })).rejects.toThrow("idempotency key");
    await expect(client.getBatch("bad")).rejects.toThrow("invalid fleet batch");
    expect(calls).toBe(1);
  });
});

describe("createFleetClient.awaitSettled", () => {
  test("polls the thread until the run completes and returns its summary as the answer", async () => {
    let poll = 0;
    const client = createFleetClient({
      ...CONFIG,
      fetch: async (url) => {
        expect(url).toBe("https://fleet.test/api/runs/run_1?thread=1");
        poll++;
        const status = poll < 3 ? "running" : "completed";
        const summary = poll < 3 ? null : "the final answer";
        return jsonResponse(200, { thread: [makeRun({ status, summary })] });
      },
    });
    const settled = await client.awaitSettled("run_1", {
      pollMs: 0,
      now: () => 0,
      sleep: async () => {},
    });
    expect(settled.status).toBe("completed");
    expect(settled.answer).toBe("the final answer");
    expect(settled.url).toBe("https://fleet.test/session/run_1");
    expect(poll).toBe(3);
  });

  test("returns status timeout once the deadline passes", async () => {
    let clock = 0;
    const client = createFleetClient({
      ...CONFIG,
      fetch: async () => jsonResponse(200, { thread: [makeRun({ status: "running" })] }),
    });
    const settled = await client.awaitSettled("run_1", {
      timeoutMs: 10,
      now: () => (clock += 6), // 6, 12 -> crosses the 10ms deadline on the 2nd check
      sleep: async () => {},
    });
    expect(settled.status).toBe("timeout");
    expect(settled.run).not.toBeNull();
  });
});

describe("createFleetClient.verify", () => {
  test("posts a reply run in the thread and parses its VERDICT", async () => {
    const calls: { url: string; body?: string }[] = [];
    const client = createFleetClient({
      ...CONFIG,
      fetch: async (url, init) => {
        calls.push({ url, body: init?.body });
        if (url.endsWith("/api/runs")) return jsonResponse(201, { id: "verify_1", status: "queued" });
        return jsonResponse(200, {
          thread: [
            makeRun({ id: "verify_1", thread_id: "run_1", parent_run_id: "run_1", status: "completed", summary: "checked it\nVERDICT: PASS" }),
          ],
        });
      },
    });
    const result = await client.verify("run_1", "Confirm it works. Emit VERDICT: PASS or VERDICT: FAIL.", {
      now: () => 0,
      sleep: async () => {},
    });

    expect(result.verdict).toBe("pass");
    expect(result.evidence).toContain("VERDICT: PASS");
    expect(result.runId).toBe("verify_1");
    expect(result.status).toBe("completed");
    // The verifier run is a reply chained under the original run.
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ parent_run_id: "run_1" });
  });
});

describe("createFleetClient.listRecent", () => {
  test("reads the summary listing and drops malformed rows", async () => {
    const client = createFleetClient({
      ...CONFIG,
      fetch: async (url) => {
        expect(url).toBe("https://fleet.test/api/runs?view=summary&limit=5");
        return jsonResponse(200, {
          runs: [
            {
              id: "run_a",
              prompt: "p",
              model: "m",
              engine: "opencode",
              status: "completed",
              summary: "done",
              duration_ms: 10,
              repo: null,
              repos: [],
              repo_specs: [],
              created_at: "2026-08-24T00:00:00.000Z",
              updated_at: "2026-08-24T00:00:00.000Z",
              latest_run_id: "run_a",
              latest_status: "completed",
              latest_created_at: "2026-08-24T00:00:00.000Z",
              latest_updated_at: "2026-08-24T00:00:00.000Z",
            },
            { nope: 1 },
          ],
        });
      },
    });
    const runs = await client.listRecent(5);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe("run_a");
  });
});

describe("parseVerdict", () => {
  test("reads PASS and FAIL case-insensitively, through surrounding markdown", () => {
    expect(parseVerdict("all good\nVERDICT: PASS")).toBe("pass");
    expect(parseVerdict("**verdict: fail**")).toBe("fail");
  });
  test("takes the LAST verdict when a prompt restates the instruction", () => {
    expect(parseVerdict("emit VERDICT: PASS or VERDICT: FAIL\n...\nVERDICT: FAIL")).toBe("fail");
  });
  test("is unknown when no verdict marker is present", () => {
    expect(parseVerdict("I could not determine the outcome.")).toBe("unknown");
    expect(parseVerdict("")).toBe("unknown");
  });
});

describe("fleetRunUrl", () => {
  test("joins base + /session/ + id, trimming trailing slashes", () => {
    expect(fleetRunUrl("https://x.dev/", "run_9")).toBe("https://x.dev/session/run_9");
    expect(fleetRunUrl("https://x.dev", "run_9")).toBe("https://x.dev/session/run_9");
  });
});
