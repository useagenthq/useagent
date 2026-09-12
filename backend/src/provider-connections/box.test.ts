import { describe, expect, test } from "bun:test";
import { BoxConnectionValidationError, boxValidationHttpStatus, validateBoxConnection } from "./box";

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname.replace("/api/box/v1", "");
    calls.push(`${init.method ?? "GET"} ${path}`);
    const route = routes[path] ?? { status: 404, body: { ok: false } };
    return new Response(JSON.stringify(route.body ?? { ok: true }), { status: route.status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

const apiUrl = "https://box.example.test/api/box/v1";

describe("Box connection validation", () => {
  test("a good key proves itself with /me and never creates a box", async () => {
    const api = fakeFetch({ "/me": { status: 200, body: { ok: true, type: "me" } } });
    await validateBoxConnection({ apiKey: "box_ok" }, { fetchImpl: api.fetchImpl, apiUrl });
    expect(api.calls).toEqual(["GET /me"]);
  });

  test("a named snapshot must be visible to the account", async () => {
    const api = fakeFetch({
      "/me": { status: 200, body: { ok: true } },
      "/snapshots": { status: 200, body: { ok: true, snapshots: [{ id: "snap_1", name: "useagent-runtime" }] } },
    });
    await validateBoxConnection({ apiKey: "k", snapshotName: "useagent-runtime" }, { fetchImpl: api.fetchImpl, apiUrl });
    await validateBoxConnection({ apiKey: "k", snapshotName: "snap_1" }, { fetchImpl: api.fetchImpl, apiUrl });
    await expect(validateBoxConnection({ apiKey: "k", snapshotName: "missing" }, { fetchImpl: api.fetchImpl, apiUrl }))
      .rejects.toMatchObject({ code: "snapshot_not_found" });
  });

  test("maps HTTP failures onto validation codes and statuses", async () => {
    for (const [status, code] of [[401, "authentication_failed"], [403, "forbidden"], [429, "rate_limited"], [503, "provider_unavailable"]] as const) {
      const api = fakeFetch({ "/me": { status, body: { ok: false } } });
      await expect(validateBoxConnection({ apiKey: "k" }, { fetchImpl: api.fetchImpl, apiUrl })).rejects.toMatchObject({ code });
    }
    const down = { fetchImpl: async () => { throw new Error("ECONNRESET"); }, apiUrl };
    await expect(validateBoxConnection({ apiKey: "k" }, down)).rejects.toBeInstanceOf(BoxConnectionValidationError);
    expect(boxValidationHttpStatus("authentication_failed")).toBe(401);
    expect(boxValidationHttpStatus("snapshot_not_found")).toBe(404);
    expect(boxValidationHttpStatus("provider_unavailable")).toBe(503);
  });
});
