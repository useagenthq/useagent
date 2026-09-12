import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SandboxProvider } from "@useagent/sandbox-contract";
import type { AppEnv } from "../src/http";
import { createProviderConnectionsRoutes } from "../src/provider-connections/routes";
import { setRunSandbox } from "../src/runs/repo";
import { clearMissingRetainedSandboxMappings, listCurrentRetainedSandboxMappings } from "../src/fleet/lease-repo";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";
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
    expect(bindingSnapshot({ ...envBinding, kind: "box" }, "DAYTONA_SNAPSHOT")).toBeDefined();
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
    expect(bindingSnapshot(binding, "DAYTONA_SNAPSHOT")).toBe("my-box-snap");

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

  test("the restricted gateway resolves personal computers through its filtered credential view", async () => {
    const built: string[] = [];
    const binding = await resolveSandboxBindingForRun(
      { orgId: "org", userId: "user" },
      {
        env: {
          USER_COMPUTERS: "on",
          GATEWAY_DATABASE_URL: "postgres://restricted",
        },
        envProvider: () => envBinding,
        gatewayConnection: async ({ orgId, userId, providers }) => {
          expect({ orgId, userId, providers }).toEqual({
            orgId: "org",
            userId: "user",
            providers: ["daytona", "box"],
          });
          return {
            provider: "box",
            value: "box_gateway_key",
            metadata: { snapshotName: "box-snapshot" },
          };
        },
        providers: {
          box: (key: string) => {
            built.push(key);
            return fakeProvider("box-gateway");
          },
        },
      },
    );

    expect(binding).toMatchObject({
      kind: "box",
      credential: "user",
      snapshot: "box-snapshot",
      userId: "user",
    });
    expect(built).toEqual(["box_gateway_key"]);
  });

  test("the hosted gateway role can read computer metadata through the filtered view and label trust anchor", async () => {
    const { cookies, orgId } = await createOrgSession("binding-gateway-role");
    const userId = await userIdForCookies(cookies);
    const app = new Hono<AppEnv>().route(
      "/api/provider-connections",
      createProviderConnectionsRoutes({ validateCredential: async () => {} }),
    );
    const saved = await app.request(
      "/api/provider-connections/box/api-key",
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: cookies },
        body: JSON.stringify({
          apiKey: "box_restricted_view",
          metadata: { snapshotName: "native-desktop" },
        }),
      },
    );
    expect(saved.status).toBe(200);

    const roles = await db.execute(sql`
      select rolname from pg_roles
      where rolname in ('useagent_gateway', 'skynet_gateway')
      order by (rolname = 'useagent_gateway') desc
      limit 1
    `);
    const role = roles[0]?.rolname;
    if (typeof role !== "string") return;

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local role "${role}"`));
      await tx.execute(sql`select sandbox_id from sandbox_labels limit 0`);
      return tx.execute(sql`
        select provider, metadata
        from gateway_provider_api_key_credentials
        where org_id = ${orgId}
          and user_id = ${userId}
          and provider = 'box'
      `);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "box",
      metadata: { snapshotName: "native-desktop" },
    });
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
