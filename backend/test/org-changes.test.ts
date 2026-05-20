import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import server from "../src/index";
import { db } from "../src/db/client";
import { member, user } from "../src/db/schema";
import {
  publishOrgChange,
  publishRunLifecycleChange,
  type ClientOrgChange,
} from "../src/runs/org-signals";
import { BASE, ORIGIN, createOrgSession, fetchApi, json, uid, waitFor } from "./helpers";

type AutomationChange = Extract<ClientOrgChange, { type: "automation" }>;

interface OpenChanges {
  readonly response: Response;
  readonly changes: ClientOrgChange[];
  close(): Promise<void>;
}

async function openChanges(cookies: string): Promise<OpenChanges> {
  const controller = new AbortController();
  const response = await server.fetch(new Request(`${BASE}/api/runs/changes`, {
    headers: { cookie: cookies, origin: ORIGIN },
    signal: controller.signal,
  }));
  const changes: ClientOrgChange[] = [];
  const reader = response.body?.getReader() ?? null;
  const pump = (async () => {
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data:"));
          if (data) changes.push(JSON.parse(data.slice(5).trim()) as ClientOrgChange);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Expected when close aborts the request.
    }
  })();
  return {
    response,
    changes,
    async close() {
      controller.abort();
      try {
        await reader?.cancel();
      } catch {
        // The request abort can close the stream before reader cancellation.
      }
      await pump;
    },
  };
}

const opened: OpenChanges[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

function automationChanges(changes: readonly ClientOrgChange[]): AutomationChange[] {
  return changes.filter(
    (change): change is AutomationChange => change.type === "automation",
  );
}

describe("org changes stream", () => {
  async function userIdForEmail(email: string): Promise<string> {
    const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (!account) throw new Error(`missing test user ${email}`);
    return account.id;
  }

  test("keeps legacy unscoped lifecycle publications off every org stream", async () => {
    const org = await createOrgSession("changes-legacy");
    const stream = await openChanges(org.cookies);
    opened.push(stream);

    publishRunLifecycleChange({
      orgId: null,
      threadId: "legacy-thread",
      runId: "legacy-run",
      kind: "settled",
    });

    await Bun.sleep(20);
    expect(stream.changes).toEqual([]);
  });

  test("streams run and artifact invalidations only to the authorized org", async () => {
    const orgA = await createOrgSession("changes-a");
    const orgB = await createOrgSession("changes-b");
    const streamA = await openChanges(orgA.cookies);
    const streamB = await openChanges(orgB.cookies);
    opened.push(streamA, streamB);

    expect(streamA.response.status).toBe(200);
    expect(streamA.response.headers.get("content-type")).toContain("text/event-stream");
    expect(streamA.response.headers.get("cache-control")).toContain("no-transform");
    expect(streamA.response.headers.get("x-accel-buffering")).toBe("no");

    publishRunLifecycleChange({
      orgId: orgA.orgId,
      threadId: "thread-a",
      runId: "run-a",
      kind: "running",
    });
    publishOrgChange(orgA.orgId, {
      type: "artifact",
      action: "created",
      artifactId: "artifact-a",
      runId: "run-a",
      threadId: "thread-a",
    });

    await waitFor(async () => streamA.changes.length === 2);
    expect(streamA.changes).toEqual([
      {
        type: "run",
        action: "running",
        runId: "run-a",
        threadId: "thread-a",
      },
      {
        type: "artifact",
        action: "created",
        artifactId: "artifact-a",
        runId: "run-a",
        threadId: "thread-a",
      },
    ]);
    expect(streamB.changes).toEqual([]);
  });

  test("both automation route names stream every mutation only to the active org", async () => {
    const owner = await createOrgSession("changes-automation-owner");
    const other = await createOrgSession("changes-automation-other");
    const ownerStream = await openChanges(owner.cookies);
    const otherStream = await openChanges(other.cookies);
    opened.push(ownerStream, otherStream);

    const expected: AutomationChange[] = [];
    for (const route of ["/api/automations", "/api/schedules"] as const) {
      const created = await json<{ id: string }>(route, {
        method: "POST",
        body: {
          name: `Realtime ${route}`,
          cron: "0 11 * * 1-5",
          prompt: "prepare a weekday status note",
          engine: "mock",
        },
        cookies: owner.cookies,
      });
      expect(created.status).toBe(201);

      const updated = await json<unknown>(`${route}/${created.body.id}`, {
        method: "PATCH",
        body: { name: `Updated ${route}` },
        cookies: owner.cookies,
      });
      expect(updated.status).toBe(200);

      const fired = await json<{ run_id: string }>(`${route}/${created.body.id}/run-now`, {
        method: "POST",
        cookies: owner.cookies,
      });
      expect(fired.status).toBe(201);

      const deleted = await json<unknown>(`${route}/${created.body.id}`, {
        method: "DELETE",
        cookies: owner.cookies,
      });
      expect(deleted.status).toBe(204);

      expected.push(
        { type: "automation", action: "created", automationId: created.body.id },
        { type: "automation", action: "updated", automationId: created.body.id },
        {
          type: "automation",
          action: "fired",
          automationId: created.body.id,
          runId: fired.body.run_id,
        },
        { type: "automation", action: "deleted", automationId: created.body.id },
      );
    }

    await waitFor(async () => automationChanges(ownerStream.changes).length === expected.length);
    expect(automationChanges(ownerStream.changes)).toEqual(expected);
    expect(otherStream.changes).toEqual([]);
  });

  test("streams provider connection invalidations only to the owning user without credential material", async () => {
    const org = await createOrgSession("changes-provider-connection");
    const other = await createOrgSession("changes-provider-other");
    const ownerUserId = await userIdForEmail(org.email);
    const otherUserId = await userIdForEmail(other.email);
    await db.insert(member).values({
      id: uid("member"),
      organizationId: org.orgId,
      userId: otherUserId,
      role: "member",
      createdAt: new Date(),
    });
    const setActive = await fetchApi("/api/auth/organization/set-active", {
      method: "POST",
      cookies: other.cookies,
      body: { organizationId: org.orgId },
    });
    expect(setActive.status).toBe(200);
    other.jar.absorb(setActive);

    const ownerStream = await openChanges(org.cookies);
    const otherStream = await openChanges(other.jar.header());
    opened.push(ownerStream, otherStream);
    const apiKey = `sk-owner-${crypto.randomUUID()}`;

    const put = await json<unknown>("/api/provider-connections/openai/api-key", {
      method: "PUT",
      cookies: org.cookies,
      body: { apiKey, metadata: { email: "owner@example.com" } },
    });
    expect(put.status).toBe(200);

    await waitFor(async () => ownerStream.changes.length === 1);
    expect(ownerStream.changes).toEqual([
      {
        type: "provider_connection",
        action: "updated",
        provider: "openai",
        authMethod: "api_key",
      },
    ]);
    await Bun.sleep(20);
    expect(otherStream.changes).toEqual([]);

    const serialized = JSON.stringify(ownerStream.changes);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(ownerUserId);
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("connectionId");
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("status");
  });

  test("keeps provider connection direct publications user-targeted on the SSE boundary", async () => {
    const org = await createOrgSession("changes-provider-direct");
    const other = await createOrgSession("changes-provider-direct-other");
    const ownerUserId = await userIdForEmail(org.email);
    const otherUserId = await userIdForEmail(other.email);
    await db.insert(member).values({
      id: uid("member"),
      organizationId: org.orgId,
      userId: otherUserId,
      role: "member",
      createdAt: new Date(),
    });
    const setActive = await fetchApi("/api/auth/organization/set-active", {
      method: "POST",
      cookies: other.cookies,
      body: { organizationId: org.orgId },
    });
    expect(setActive.status).toBe(200);
    other.jar.absorb(setActive);

    const ownerStream = await openChanges(org.cookies);
    const otherStream = await openChanges(other.jar.header());
    opened.push(ownerStream, otherStream);

    publishOrgChange(org.orgId, {
      type: "provider_connection",
      action: "revoked",
      targetUserId: ownerUserId,
      connectionId: "provider-connection-direct",
      provider: "openai",
      authMethod: "chatgpt_oauth",
      status: "revoked",
    });

    await waitFor(async () => ownerStream.changes.length === 1);
    expect(ownerStream.changes).toEqual([
      {
        type: "provider_connection",
        action: "revoked",
        provider: "openai",
        authMethod: "chatgpt_oauth",
      },
    ]);
    await Bun.sleep(20);
    expect(otherStream.changes).toEqual([]);
  });
});
