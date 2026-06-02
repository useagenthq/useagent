import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { apiKeys, member, user } from "../src/db/schema";
import { extractBearerToken, isBearerAllowedPath } from "../src/middleware/bearer";
import { createOrgSession, fetchApi, json, uid, waitFor, type OrgSession } from "./helpers";

// Org API keys + the fail-closed bearer lane. A key is minted through the
// SESSION-authenticated management API, stored as a SHA-256 hash (never the
// plaintext), and used as `Authorization: Bearer uak_...` against a
// deny-by-default route allowlist. These tests pin: hash-only storage, auth on
// the allowlisted routes, org confinement, revocation, malformed/unknown 401s,
// bearer being locked out of management + non-allowlisted routes, and the
// throttled last_used stamp.

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

/** Mint a key through the session management API; returns the one-time secret. */
async function mintKey(
  org: OrgSession,
  name = "local dispatch",
): Promise<{ key: string; id: string; prefix: string }> {
  const res = await json<any>("/api/api-keys", {
    method: "POST",
    cookies: org.cookies,
    body: { name },
  });
  expect(res.status).toBe(201);
  return { key: res.body.key, id: res.body.id, prefix: res.body.prefix };
}

describe("api keys - creation stores only a hash", () => {
  test("POST mints a uak_ secret shown once; the row holds only its hash + prefix", async () => {
    const org = await createOrgSession("ak-create");
    const { key, id, prefix } = await mintKey(org, "ci-runner");

    // Shape of the secret: uak_ + 40 base64url chars = 44 total.
    expect(key.startsWith("uak_")).toBe(true);
    expect(key.length).toBeGreaterThanOrEqual(44);
    expect(prefix).toBe(key.slice(0, 12));

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row).toBeTruthy();
    // Only the hash + display prefix are persisted; a fresh key is unused + live.
    expect(row!.keyHash).toBe(sha256hex(key));
    expect(row!.keyPrefix).toBe(prefix);
    expect(row!.lastUsedAt).toBeNull();
    expect(row!.revokedAt).toBeNull();
    // The secret material beyond the display prefix must never be stored anywhere.
    expect(JSON.stringify(row)).not.toContain(key.slice(12));

    // A second key gets a distinct secret + hash (fresh randomness).
    const second = await mintKey(org, "second");
    expect(second.key).not.toBe(key);
    expect(sha256hex(second.key)).not.toBe(row!.keyHash);

    // The list surfaces metadata only - never a secret or a hash.
    const list = await json<{ keys: any[] }>("/api/api-keys", { cookies: org.cookies });
    expect(list.status).toBe(200);
    const mine = list.body.keys.find((k) => k.id === id);
    expect(Object.keys(mine).sort()).toEqual([
      "createdAt",
      "id",
      "lastUsedAt",
      "name",
      "prefix",
      "revokedAt",
    ]);
    for (const leak of ["key", "keyHash", "key_hash", "hash", "secret"]) {
      expect(mine[leak]).toBeUndefined();
    }
  });
});

describe("api keys - bearer lane authenticates allowlisted routes", () => {
  test("a live key dispatches POST /api/runs and reads the run + list", async () => {
    const org = await createOrgSession("ak-auth");
    const { key } = await mintKey(org);

    const created = await json<any>("/api/runs", {
      method: "POST",
      headers: bearer(key),
      body: { prompt: "hello from a local key" },
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTruthy();

    // Read the dispatched run/thread back through the same key.
    const thread = await json<any>(`/api/runs/${created.body.id}`, { headers: bearer(key) });
    expect(thread.status).toBe(200);

    // The read-only list is reachable too.
    const list = await json<any>("/api/runs", { headers: bearer(key) });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.runs)).toBe(true);
  });

  test("a bearer key cannot open the interactive terminal WebSocket", async () => {
    const org = await createOrgSession("ak-terminal-deny");
    const { key } = await mintKey(org);
    const created = await json<any>("/api/runs", {
      method: "POST",
      headers: bearer(key),
      body: { prompt: "terminal denial fixture" },
    });
    expect(created.status).toBe(201);

    const denied = await json(`/api/runs/${created.body.id}/terminal`, {
      headers: bearer(key),
    });
    expect(denied.status).toBe(401);
  });

  test("a key is confined to its own org's runs (cross-org read is 404)", async () => {
    const orgA = await createOrgSession("ak-iso-a");
    const orgB = await createOrgSession("ak-iso-b");
    const { key: keyA } = await mintKey(orgA);

    const bRun = await json<any>("/api/runs", {
      method: "POST",
      cookies: orgB.cookies,
      body: { prompt: "org B private run" },
    });
    expect(bRun.status).toBe(201);

    const cross = await json<any>(`/api/runs/${bRun.body.id}`, { headers: bearer(keyA) });
    expect(cross.status).toBe(404);
  });

  test("a successful bearer call stamps last_used_at (throttled, fire-and-forget)", async () => {
    const org = await createOrgSession("ak-lastused");
    const { key, id } = await mintKey(org);

    const [before] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(before!.lastUsedAt).toBeNull();

    const ok = await json<any>("/api/config", { headers: bearer(key) });
    expect(ok.status).toBe(200);

    const stamped = await waitFor(async () => {
      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
      return row?.lastUsedAt ? row : null;
    });
    expect(stamped.lastUsedAt).not.toBeNull();
  });
});

describe("api keys - fail closed", () => {
  test("a revoked key is rejected 401 and the row is kept", async () => {
    const org = await createOrgSession("ak-revoke");
    const { key, id } = await mintKey(org);

    const del = await json<any>(`/api/api-keys/${id}`, {
      method: "DELETE",
      cookies: org.cookies,
    });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ revoked: true, id });

    // The row survives (audit trail) with revoked_at stamped.
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row).toBeTruthy();
    expect(row!.revokedAt).not.toBeNull();

    // The key no longer authenticates.
    expect((await json("/api/runs", { headers: bearer(key) })).status).toBe(401);

    // Revoking again is a no-op 404 (nothing left to revoke).
    const again = await json<any>(`/api/api-keys/${id}`, {
      method: "DELETE",
      cookies: org.cookies,
    });
    expect(again.status).toBe(404);
  });

  test("a malformed or unknown key is rejected 401 (never falls through to dev-org)", async () => {
    const unknown = await json<any>("/api/runs", {
      headers: bearer("uak_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
    });
    expect(unknown.status).toBe(401);

    const malformed = await json<any>("/api/runs", {
      headers: { authorization: "Bearer uak_short" },
    });
    expect(malformed.status).toBe(401);
  });

  test("removing the key owner from the org immediately invalidates the key", async () => {
    const org = await createOrgSession("ak-removed-member");
    const { key } = await mintKey(org);
    const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, org.email));
    expect(owner).toBeTruthy();

    await db
      .delete(member)
      .where(and(eq(member.organizationId, org.orgId), eq(member.userId, owner!.id)));

    expect((await json("/api/runs", { headers: bearer(key) })).status).toBe(401);
  });
});

describe("api keys - personal ownership", () => {
  test("one org member cannot list or revoke another member's key", async () => {
    const owner = await createOrgSession("ak-owner");
    const other = await createOrgSession("ak-other");
    const [otherUser] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, other.email));
    expect(otherUser).toBeTruthy();

    await db.insert(member).values({
      id: uid("member"),
      organizationId: owner.orgId,
      userId: otherUser!.id,
      role: "member",
      createdAt: new Date(),
    });
    const setActive = await fetchApi("/api/auth/organization/set-active", {
      method: "POST",
      cookies: other.cookies,
      body: { organizationId: owner.orgId },
    });
    expect(setActive.status).toBe(200);
    other.jar.absorb(setActive);
    other.cookies = other.jar.header();

    const created = await mintKey(owner, "owner-only");
    const list = await json<{ keys: Array<{ id: string }> }>("/api/api-keys", {
      cookies: other.cookies,
    });
    expect(list.status).toBe(200);
    expect(list.body.keys.some((key) => key.id === created.id)).toBe(false);

    const revoke = await json(`/api/api-keys/${created.id}`, {
      method: "DELETE",
      cookies: other.cookies,
    });
    expect(revoke.status).toBe(404);
    expect((await json("/api/runs", { headers: bearer(created.key) })).status).toBe(200);
  });
});

describe("api keys - bearer is denied outside the allowlist", () => {
  test("a live key cannot manage keys or reach a non-allowlisted route (401)", async () => {
    const org = await createOrgSession("ak-deny");
    const { key } = await mintKey(org);

    // Key management is session-only - a bearer key can neither list nor create.
    expect((await json("/api/api-keys", { headers: bearer(key) })).status).toBe(401);
    expect(
      (await json("/api/api-keys", { method: "POST", headers: bearer(key), body: { name: "x" } }))
        .status,
    ).toBe(401);

    // A non-allowlisted org route (secrets) is unreachable by a key.
    expect((await json("/api/secrets", { headers: bearer(key) })).status).toBe(401);
  });
});

describe("bearer allowlist - deny by default (pure)", () => {
  test("allows exactly the v1 dispatch + read routes", () => {
    expect(isBearerAllowedPath("GET", "/api/config")).toBe(true);
    expect(isBearerAllowedPath("POST", "/api/runs")).toBe(true);
    expect(isBearerAllowedPath("GET", "/api/runs")).toBe(true);
    expect(isBearerAllowedPath("GET", "/api/runs/abc")).toBe(true);
    expect(isBearerAllowedPath("GET", "/api/runs/abc/thread-events")).toBe(true);
    expect(isBearerAllowedPath("GET", "/api/artifacts")).toBe(true);
    expect(isBearerAllowedPath("GET", "/api/artifacts/xyz/workpiece")).toBe(true);
  });

  test("denies management, mutations, and everything unlisted", () => {
    const denied: Array<[string, string]> = [
      ["POST", "/api/config"],
      ["POST", "/api/runs/abc/cancel"],
      ["POST", "/api/runs/abc/questions/q1/reply"],
      ["DELETE", "/api/runs/abc/sandbox"],
      ["POST", "/api/artifacts"],
      ["PATCH", "/api/artifacts/abc/workpiece"],
      ["GET", "/api/api-keys"],
      ["POST", "/api/api-keys"],
      ["DELETE", "/api/api-keys/abc"],
      ["GET", "/api/secrets"],
      ["GET", "/api/health"],
      ["GET", "/api/integrations"],
      ["GET", "/api/memory"],
      ["GET", "/api/runsomething"],
      ["GET", "/api/artifactsX"],
      ["GET", "/api/runs/abc/terminal"],
      ["GET", "/api/runs/abc/anything-new"],
      ["GET", "/api/artifacts/abc/anything-new"],
      ["GET", "/api/anything-new"],
    ];
    for (const [method, path] of denied) {
      expect(isBearerAllowedPath(method, path)).toBe(false);
    }
  });

  test("extractBearerToken claims only uak_ bearer tokens", () => {
    expect(extractBearerToken("Bearer uak_abc")).toBe("uak_abc");
    expect(extractBearerToken("bearer uak_abc")).toBe("uak_abc"); // scheme case-insensitive
    expect(extractBearerToken("Bearer session-jwt")).toBeNull();
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(extractBearerToken("uak_abc")).toBeNull(); // no scheme
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
  });
});
