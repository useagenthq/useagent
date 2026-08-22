import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createOperatorRoutes } from "./operator-routes";

const SECRET = "operator-test-secret";

function makeApp() {
  const calls: { pump: string[]; cancel: Array<[string, string]>; approve: string[] } = {
    pump: [],
    cancel: [],
    approve: [],
  };
  const app = createOperatorRoutes({
    pump: async (threadId) => {
      calls.pump.push(threadId);
      return `dispatched-${threadId}`;
    },
    cancel: (runId, reason) => {
      calls.cancel.push([runId, reason]);
      return true;
    },
    approveGatewayRequest: async (requestId) => {
      calls.approve.push(requestId);
      return { approved: true };
    },
    admitReleaseParity: async (c, body) =>
      c.json({ orgId: c.get("orgId"), userId: c.get("userId"), prompt: body.prompt }, 201),
  });
  return { app, calls };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://loopback${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("operator dispatch bridge", () => {
  let previousSecret: string | undefined;
  beforeEach(() => {
    previousSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = SECRET;
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previousSecret;
  });

  test("pumps a thread in-process for a loopback caller with the operator secret", async () => {
    const { app, calls } = makeApp();
    const response = await app.fetch(
      post("/pump-thread", { threadId: "thread-1" }, { authorization: `Bearer ${SECRET}` }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dispatched: "dispatched-thread-1" });
    expect(calls.pump).toEqual(["thread-1"]);
  });

  test("signals a cancel with the presented reason", async () => {
    const { app, calls } = makeApp();
    const response = await app.fetch(
      post("/signal-cancel", { runId: "run-9", reason: "gate teardown" }, {
        authorization: `Bearer ${SECRET}`,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signalled: true });
    expect(calls.cancel).toEqual([["run-9", "gate teardown"]]);
  });

  test("admits parity only through the authenticated operator lane with server identity", async () => {
    const { app } = makeApp();
    const response = await app.fetch(
      post(
        "/admit-release-eval",
        { orgId: "org-1", userId: "user-1", run: { prompt: "probe" } },
        { authorization: `Bearer ${SECRET}`, "idempotency-key": "parity-1" },
      ),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ orgId: "org-1", userId: "user-1", prompt: "probe" });
  });

  test("approves a gateway approval request through the canary hook", async () => {
    const { app, calls } = makeApp();
    const response = await app.fetch(
      post("/approve-gateway-request", { requestId: "req-1" }, {
        authorization: `Bearer ${SECRET}`,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ approved: true });
    expect(calls.approve).toEqual(["req-1"]);
  });

  test("rejects a missing or wrong secret without touching the worker", async () => {
    const { app, calls } = makeApp();
    expect((await app.fetch(post("/pump-thread", { threadId: "t" }))).status).toBe(401);
    expect(
      (await app.fetch(
        post("/pump-thread", { threadId: "t" }, { authorization: "Bearer nope" }),
      )).status,
    ).toBe(401);
    expect(calls.pump).toEqual([]);
  });

  test("rejects proxied requests outright: X-Forwarded-For means not loopback", async () => {
    const { app, calls } = makeApp();
    const response = await app.fetch(
      post("/pump-thread", { threadId: "t" }, {
        authorization: `Bearer ${SECRET}`,
        "x-forwarded-for": "203.0.113.9",
      }),
    );
    expect(response.status).toBe(404);
    expect(calls.pump).toEqual([]);
  });

  test("refuses to run with no secret configured", async () => {
    delete process.env.BETTER_AUTH_SECRET;
    const { app, calls } = makeApp();
    const response = await app.fetch(
      post("/pump-thread", { threadId: "t" }, { authorization: "Bearer " }),
    );
    expect(response.status).toBe(401);
    expect(calls.pump).toEqual([]);
  });

  test("requires a threadId / runId / requestId", async () => {
    const { app } = makeApp();
    expect(
      (await app.fetch(post("/pump-thread", {}, { authorization: `Bearer ${SECRET}` }))).status,
    ).toBe(400);
    expect(
      (await app.fetch(post("/signal-cancel", {}, { authorization: `Bearer ${SECRET}` }))).status,
    ).toBe(400);
    expect(
      (await app.fetch(
        post("/approve-gateway-request", {}, { authorization: `Bearer ${SECRET}` }),
      )).status,
    ).toBe(400);
    expect(
      (await app.fetch(
        post("/admit-release-eval", { run: {} }, { authorization: `Bearer ${SECRET}` }),
      )).status,
    ).toBe(400);
  });
});
