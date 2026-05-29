import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as backend from "@/lib/backend-fetch";
import { fetchSidebarRuns } from "./runs-data";

async function waitForCalls(spy: { mock: { calls: unknown[] } }, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (spy.mock.calls.length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(spy.mock.calls).toHaveLength(count);
}

afterEach(() => {
  (backend.backendFetch as { mockRestore?: () => void }).mockRestore?.();
});

describe("fetchSidebarRuns", () => {
  test("shares one compact backend request across concurrent sidebar consumers", async () => {
    const summaries = [{ id: "run-1", prompt: "hello", status: "running" }];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = spyOn(backend, "backendFetch").mockImplementation(async () => {
      await gate;
      return new Response(JSON.stringify({ runs: summaries }), { status: 200 });
    });

    const projects = fetchSidebarRuns();
    const threads = fetchSidebarRuns();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/api/runs?view=summary&limit=100&include_active=1",
      { cache: "no-store" },
    );

    release();
    expect(await projects).toEqual(summaries);
    expect(await threads).toEqual(summaries);
  });

  test("queues one shared follow-up when invalidated during an in-flight request", async () => {
    const releases: Array<() => void> = [];
    const request = spyOn(backend, "backendFetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          const call = releases.length + 1;
          releases.push(() =>
            resolve(new Response(JSON.stringify({ runs: [{ id: `run-${call}` }] }))),
          );
        }),
    );

    const initial = fetchSidebarRuns();
    const initialPeer = fetchSidebarRuns();
    const refreshed = fetchSidebarRuns({ revalidate: true });
    const refreshedPeer = fetchSidebarRuns({ revalidate: true });
    expect(request).toHaveBeenCalledTimes(1);

    releases[0]!();
    await waitForCalls(request, 2);
    expect(request).toHaveBeenCalledTimes(2);

    releases[1]!();
    expect(await initial).toEqual([{ id: "run-2" }]);
    expect(await initialPeer).toEqual([{ id: "run-2" }]);
    expect(await refreshed).toEqual([{ id: "run-2" }]);
    expect(await refreshedPeer).toEqual([{ id: "run-2" }]);
  });

  test("reissues again when another invalidation arrives during the follow-up", async () => {
    const releases: Array<() => void> = [];
    const request = spyOn(backend, "backendFetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          const call = releases.length + 1;
          releases.push(() =>
            resolve(new Response(JSON.stringify({ runs: [{ id: `run-${call}` }] }))),
          );
        }),
    );

    const result = fetchSidebarRuns();
    void fetchSidebarRuns({ revalidate: true });
    releases[0]!();
    await waitForCalls(request, 2);
    expect(request).toHaveBeenCalledTimes(2);

    void fetchSidebarRuns({ revalidate: true });
    releases[1]!();
    await waitForCalls(request, 3);
    expect(request).toHaveBeenCalledTimes(3);

    releases[2]!();
    expect(await result).toEqual([{ id: "run-3" }]);
  });
});
