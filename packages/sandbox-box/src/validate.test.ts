import { describe, expect, test } from "bun:test";
import { SandboxCredentialError } from "@useagent/sandbox-contract";
import { boxPlugin } from "./plugin";
import { validateBoxConnection } from "./validate";

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

describe("Box credential validation", () => {
  test("a working key without a snapshot only calls /me", async () => {
    const api = fakeFetch({ "/me": { status: 200, body: { ok: true, user: { id: "u1" } } } });
    await validateBoxConnection({ apiKey: "box_k" }, { fetchImpl: api.fetchImpl });
    expect(api.calls).toEqual(["GET /me"]);
  });

  test("a named snapshot must be visible to the account", async () => {
    const api = fakeFetch({
      "/me": { status: 200 },
      "/snapshots": { status: 200, body: { ok: true, snapshots: [{ id: "snap_1", name: "useagent-runtime" }] } },
    });
    await validateBoxConnection({ apiKey: "box_k", snapshotName: "useagent-runtime" }, { fetchImpl: api.fetchImpl });
    await expect(validateBoxConnection({ apiKey: "box_k", snapshotName: "missing" }, { fetchImpl: api.fetchImpl })).rejects.toMatchObject({
      name: "SandboxCredentialError",
      code: "snapshot_not_found",
      httpStatus: 404,
    });
  });

  test("HTTP failures map onto the shared credential codes and statuses", async () => {
    for (const [status, code, httpStatus] of [
      [401, "authentication_failed", 401],
      [403, "forbidden", 403],
      [429, "rate_limited", 429],
      [503, "provider_unavailable", 503],
    ] as const) {
      const api = fakeFetch({ "/me": { status } });
      const error = await validateBoxConnection({ apiKey: "box_k" }, { fetchImpl: api.fetchImpl }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxCredentialError);
      expect(error).toMatchObject({ code, httpStatus });
    }
    const down = await validateBoxConnection({ apiKey: "k" }, { fetchImpl: async () => { throw new Error("ECONNRESET"); } }).catch((e: unknown) => e);
    expect(down).toMatchObject({ code: "provider_unavailable", httpStatus: 503 });
  });

  test("the plugin validates through the same path", async () => {
    const api = fakeFetch({ "/me": { status: 401 } });
    await expect(boxPlugin.validateCredential!({ apiKey: "bad" }, { fetchImpl: api.fetchImpl })).rejects.toMatchObject({ code: "authentication_failed" });
  });
});
