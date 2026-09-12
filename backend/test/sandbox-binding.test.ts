import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SandboxProvider } from "@useagent/sandbox-contract";
import type { AppEnv } from "../src/http";
import { createProviderConnectionsRoutes } from "../src/provider-connections/routes";
import { setRunSandbox } from "../src/runs/repo";
import { clearMissingRetainedSandboxMappings, listCurrentRetainedSandboxMappings } from "../src/fleet/lease-repo";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { eq } from "drizzle-orm";
import {
  bindingSnapshot,
  resolveSandboxBindingForRun,
  resolveSandboxBindingForSandbox,
  resolveSandboxBindingForThread,
  userComputersEnabled,
  type SandboxBinding,
} from "../src/sandboxes/binding";
import { createOrgSession, fetchApi, json } from "./helpers";

const fakeProvider = (label: string): SandboxProvider =>
  ({ label } as unknown as SandboxProvider);

const envBinding: SandboxBinding = { kind: "daytona", provider: fakeProvider("env"), snapshot: null, credential: "env", userId: null };

async function userIdForCookies(cookies: string): Promise<string> {
  const me = await json<{ user?: { id?: string } }>("/api/auth/get-session", { cookies });
  const id = me.body.user?.id;
  if (!id) throw new Error("session has no user");
  return id;
}

describe("sandbox binding", () => {
  test("USER_COMPUTERS is off by default and the server's provider is the fallback", async () => {
    expect(userComputersEnabled({})).toBe(false);
    expect(userComputersEnabled({ USER_COMPUTERS: "on" })).toBe(true);
    const binding = await resolveSandboxBindingForRun(
      { orgId: "org", userId: "user" },
      { env: {}, envProvider: () => envBinding, connections: async () => { throw new Error("must not be consulted"); } },
    );
    expect(binding).toBe(envBinding);
    await expect(resolveSandboxBindingForRun({ orgId: "org", userId: "user" }, { env: {}, envProvider: () => null }))
      .rejects.toThrow(/credentials are unavailable/);
    expect(bindingSnapshot({ ...envBinding, kind: "box" }, "DAYTONA_SNAPSHOT", "fallback")).toBeDefined();
  });

  test("a connected personal computer runs the user's work, most recently updated connection first", async () => {
    const { cookies, orgId } = await createOrgSession("binding-user");
    const userId = await userIdForCookies(cookies);
    const app = new Hono<AppEnv>().route(
      "/api/provider-connections",
      createProviderConnectionsRoutes({ validateCredential: async () => {} }),
    );
    const put = (provider: string, body: Record<string, unknown>) =>
      app.request(`/api/provider-connections/${provider}/api-key`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: cookies },
        body: JSON.stringify(body),
      });
    expect((await put("daytona", { apiKey: "dtn_user", metadata: { snapshotName: "my-daytona-snap" } })).status).toBe(200);
    expect((await put("box", { apiKey: "box_user", metadata: { snapshotName: "my-box-snap" } })).status).toBe(200);

    const built: string[] = [];
    const deps = {
      env: { USER_COMPUTERS: "on" },
      envProvider: () => envBinding,
      providers: {
        box: (key: string) => { built.push(`box:${key}`); return fakeProvider("box"); },
        daytona: (key: string) => { built.push(`daytona:${key}`); return fakeProvider("daytona"); },
      },
    };
    const binding = await resolveSandboxBindingForRun({ orgId, userId }, deps);
    expect(binding.kind).toBe("box");
    expect(binding.credential).toBe("user");
    expect(binding.snapshot).toBe("my-box-snap");
    expect(built).toEqual(["box:box_user"]);
    expect(bindingSnapshot(binding, "DAYTONA_SNAPSHOT", "server-fallback")).toBe("my-box-snap");

    // Off for the org: same user, same connections, server provider.
    expect((await resolveSandboxBindingForRun({ orgId, userId }, { ...deps, env: {} })).credential).toBe("env");
    // A different user in the org has no connection: server provider.
    expect((await resolveSandboxBindingForRun({ orgId, userId: "someone-else" }, deps)).credential).toBe("env");

    // The run records who made its sandbox; later touches resolve the same provider.
    const created = await json<{ id: string }>("/api/runs", { method: "POST", cookies, body: { prompt: "Work.", engine: "mock" } });
    expect(created.status).toBe(201);
    await setRunSandbox(created.body.id, "bx_user_1", { kind: binding.kind, credential: binding.credential });
    const byThread = await resolveSandboxBindingForThread(orgId, created.body.id, deps);
    expect(byThread.kind).toBe("box");
    expect(byThread.credential).toBe("user");
    const bySandbox = await resolveSandboxBindingForSandbox("bx_user_1", deps);
    expect(bySandbox.kind).toBe("box");

    // Revoking the connection makes those touches fail loudly instead of falling back to the server's account.
    const revoked = await fetchApi("/api/provider-connections/box/revoke?authMethod=api_key", { method: "POST", cookies });
    expect(revoked.status).toBe(200);
    await expect(resolveSandboxBindingForThread(orgId, created.body.id, deps)).rejects.toThrow(/revoked/);

    // A sandbox recorded as the server's stays the server's even with a personal connection present.
    const serverRun = await json<{ id: string }>("/api/runs", { method: "POST", cookies, body: { prompt: "Server work.", engine: "mock" } });
    await setRunSandbox(serverRun.body.id, "srv_1", { kind: "daytona", credential: "env" });
    expect((await resolveSandboxBindingForSandbox("srv_1", deps)).credential).toBe("env");
    // Runs from before this record (no binding columns) also resolve to the server's provider.
    const legacyRun = await json<{ id: string }>("/api/runs", { method: "POST", cookies, body: { prompt: "Legacy.", engine: "mock" } });
    await setRunSandbox(legacyRun.body.id, "legacy_1");
    expect((await resolveSandboxBindingForSandbox("legacy_1", deps)).credential).toBe("env");
  });

  test("reconciling the deployment provider's listing leaves personal-computer mappings alone", async () => {
    const { cookies } = await createOrgSession("binding-reconcile");
    const serverRun = await json<{ id: string }>("/api/runs", { method: "POST", cookies, body: { prompt: "Server.", engine: "mock" } });
    const userRun = await json<{ id: string }>("/api/runs", { method: "POST", cookies, body: { prompt: "Personal.", engine: "mock" } });
    await setRunSandbox(serverRun.body.id, "srv_gone", { kind: "daytona", credential: "env" });
    await setRunSandbox(userRun.body.id, "bx_personal", { kind: "box", credential: "user" });

    // The deployment provider's authoritative listing returned neither id (everything else stays live).
    const others = (await listCurrentRetainedSandboxMappings()).map((m) => m.sandboxId).filter((id) => id !== "srv_gone" && id !== "bx_personal");
    await clearMissingRetainedSandboxMappings(new Set(others));

    const [server] = await db.select({ sandboxId: runs.sandboxId }).from(runs).where(eq(runs.id, serverRun.body.id));
    const [personal] = await db.select({ sandboxId: runs.sandboxId }).from(runs).where(eq(runs.id, userRun.body.id));
    expect(server?.sandboxId).toBeNull();
    expect(personal?.sandboxId).toBe("bx_personal");
  });
});
