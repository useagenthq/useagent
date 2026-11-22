import { expect, test } from "bun:test";
import { createSessionRequest, getAuthConfig, listWorkspaces, providerErrorURL, switchOrganization } from "./auth";

function countingFetcher(responses: (() => Response)[] = []) {
  const seen: string[] = [];
  const fetcher = (async (path: string) => {
    seen.push(path);
    const next = responses.shift();
    return next
      ? next()
      : Response.json({ user: { id: "u1", name: "Ada", email: "ada@example.com", image: null } });
  }) as unknown as Parameters<typeof createSessionRequest>[0];
  return { seen, fetcher };
}

test("every session consumer on a page shares one get-session request", async () => {
  const { seen, fetcher } = countingFetcher();
  const request = createSessionRequest(fetcher, { isShared: () => true });
  const [a, b] = await Promise.all([request.get(), request.get()]);
  expect(a?.user.email).toBe("ada@example.com");
  expect(b).toBe(a);
  expect(await request.get()).toBe(a);
  expect(seen).toEqual(["/api/auth/get-session"]);
});

test("invalidating the session asks the backend again", async () => {
  const { seen, fetcher } = countingFetcher();
  const request = createSessionRequest(fetcher, { isShared: () => true });
  await request.get();
  request.invalidate();
  await request.get();
  expect(seen).toHaveLength(2);
});

test("an anonymous answer is kept, a failed request is not", async () => {
  const { seen, fetcher } = countingFetcher([
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 401 }),
  ]);
  const request = createSessionRequest(fetcher, { isShared: () => true });
  await expect(request.get()).rejects.toThrow("503");
  expect(await request.get()).toBeNull();
  expect(await request.get()).toBeNull();
  expect(seen).toHaveLength(2);
});

test("the session answer expires after its ttl", async () => {
  const { seen, fetcher } = countingFetcher();
  const request = createSessionRequest(fetcher, { isShared: () => true, ttlMs: 0 });
  await request.get();
  await request.get();
  expect(seen).toHaveLength(2);
});

test("a provider identity rejected by the backend is not an authorized session", async () => {
  const { fetcher } = countingFetcher([() => new Response(null, { status: 403 })]);
  const request = createSessionRequest(fetcher, { isShared: () => true });
  await expect(request.get()).rejects.toThrow("get-session failed: 403");
});

test("provider config uses the dedicated route and fails closed", async () => {
  const seen: string[] = [];
  const fetcher = (async (path: string) => {
    seen.push(path);
    return Response.json({
      google: true,
      oidc: { label: " Acme SSO " },
      emailPassword: false,
      allowDevOrg: false,
      signup: { inviteCode: true, domains: ["acme.com", 3] },
    });
  }) as unknown as Parameters<typeof getAuthConfig>[0];

  expect(await getAuthConfig(fetcher)).toEqual({
    google: true,
    oidc: { label: "Acme SSO" },
    emailPassword: false,
    allowDevOrg: false,
    invitationEmail: null, // the server did not say
    signup: { inviteCode: true, domains: ["acme.com"] },
  });
  expect(seen).toEqual(["/api/auth/provider-config"]);

  const unavailable = (async () => new Response(null, { status: 503 })) as unknown as Parameters<
    typeof getAuthConfig
  >[0];
  expect(await getAuthConfig(unavailable)).toEqual({
    google: false,
    oidc: null,
    emailPassword: false,
    allowDevOrg: false,
    invitationEmail: null,
    signup: null,
  });
});

test("a failed provider sign-in returns to the login card, still headed for the page asked for", () => {
  expect(providerErrorURL("/")).toBe("/login?via=provider");
  expect(providerErrorURL("/agent/new?desktop=1")).toBe("/login?via=provider&redirect_url=%2Fagent%2Fnew%3Fdesktop%3D1");
});

test("a workspace row without an id or a name fails validation instead of becoming a blank selected workspace", async () => {
  const fetcher = (async () => Response.json({ activeOrganizationId: undefined, workspaces: [{}] })) as unknown as Parameters<typeof listWorkspaces>[0];
  await expect(listWorkspaces(fetcher)).rejects.toThrow("invalid response");
});

test("the workspace list carries roles and the landing workspace; the switch uses the Better Auth route", async () => {
  const seen: { path: string; init?: RequestInit }[] = [];
  const fetcher = (async (path: string, init?: RequestInit) => {
    seen.push({ path, init });
    return path.endsWith("/workspaces")
      ? Response.json({
          activeOrganizationId: "org-1",
          workspaces: [
            { id: "org-1", name: "Acme", role: "admin", members: 3, defaultName: false },
            { id: "org-2", name: "Ada's workspace", role: "owner", members: 1, defaultName: true },
          ],
        })
      : Response.json({ session: { activeOrganizationId: "org-1" } });
  }) as unknown as Parameters<typeof listWorkspaces>[0];
  const effects: string[] = [];

  expect(await listWorkspaces(fetcher)).toEqual([
    { id: "org-1", name: "Acme", role: "admin", active: true, members: 3, defaultName: false },
    { id: "org-2", name: "Ada's workspace", role: "owner", active: false, members: 1, defaultName: true },
  ]);
  await switchOrganization(
    "org-1",
    fetcher,
    () => effects.push("reload"),
    () => effects.push("invalidate"),
  );

  expect(seen[0]).toEqual({
    path: "/api/team/workspaces",
    init: { cache: "no-store" },
  });
  expect(seen[1]?.path).toBe("/api/auth/organization/set-active");
  expect(seen[1]?.init).toMatchObject({
    method: "POST",
    body: JSON.stringify({ organizationId: "org-1" }),
  });
  expect(effects).toEqual(["invalidate", "reload"]);
});

test("a denied organization switch clears cached UI and reloads the server-selected org", async () => {
  const denied = (async () => new Response(null, { status: 403 })) as unknown as Parameters<
    typeof switchOrganization
  >[1];
  const effects: string[] = [];

  await expect(
    switchOrganization(
      "not-a-membership",
      denied,
      () => effects.push("reload"),
      () => effects.push("invalidate"),
    ),
  ).rejects.toThrow("Workspace switch failed (403)");
  expect(effects).toEqual(["invalidate", "reload"]);
});

test("an uncertain organization switch also clears cached UI and reloads", async () => {
  const unavailable = (async () => {
    throw new Error("network unavailable");
  }) as unknown as Parameters<typeof switchOrganization>[1];
  const effects: string[] = [];

  await expect(
    switchOrganization(
      "org-2",
      unavailable,
      () => effects.push("reload"),
      () => effects.push("invalidate"),
    ),
  ).rejects.toThrow("network unavailable");
  expect(effects).toEqual(["invalidate", "reload"]);
});
