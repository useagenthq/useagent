import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createOperatorRoutes } from "./operator-routes";

const SECRET = "operator-test-secret-with-at-least-32-chars";

function makeApp() {
  const calls: {
    pump: string[];
    cancel: Array<[string, string]>;
    approve: string[];
    admit: Array<[string, string]>;
  } = {
    pump: [],
    cancel: [],
    approve: [],
    admit: [],
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
    admitReleaseParity: async (c, body) => {
      calls.admit.push([c.get("orgId"), c.get("userId") ?? ""]);
      return c.json({ orgId: c.get("orgId"), userId: c.get("userId"), prompt: body.prompt }, 201);
    },
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

function fetchOperator(
  app: ReturnType<typeof makeApp>["app"],
  request: Request,
  address = "127.0.0.1",
) {
  return app.fetch(request, { requestIP: () => ({ address }) });
}

describe("operator dispatch bridge", () => {
  let previousSecret: string | undefined;
  let previousAuthSecret: string | undefined;
  beforeEach(() => {
    previousSecret = process.env.USEAGENT_OPERATOR_SECRET;
    previousAuthSecret = process.env.BETTER_AUTH_SECRET;
    process.env.USEAGENT_OPERATOR_SECRET = SECRET;
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.USEAGENT_OPERATOR_SECRET;
    else process.env.USEAGENT_OPERATOR_SECRET = previousSecret;
    if (previousAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previousAuthSecret;
  });

  test("pumps a thread in-process for a loopback caller with the operator secret", async () => {
    const { app, calls } = makeApp();
    const response = await fetchOperator(
      app,
      post("/pump-thread", { threadId: "thread-1" }, { authorization: `Bearer ${SECRET}` }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dispatched: "dispatched-thread-1" });
    expect(calls.pump).toEqual(["thread-1"]);
  });

  test("uses Bun's real socket peer when served on loopback", async () => {
    const { app, calls } = makeApp();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/pump-thread`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadId: "thread-live" }),
      });
      expect(response.status).toBe(200);
      expect(calls.pump).toEqual(["thread-live"]);
    } finally {
      server.stop(true);
    }
  });

  test("signals a cancel with the presented reason", async () => {
    const { app, calls } = makeApp();
    const response = await fetchOperator(
      app,
      post(
        "/signal-cancel",
        { runId: "run-9", reason: "gate teardown" },
        { authorization: `Bearer ${SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signalled: true });
    expect(calls.cancel).toEqual([["run-9", "gate teardown"]]);
  });

  test("admits parity only through the authenticated operator lane with server identity", async () => {
    const { app, calls } = makeApp();
    const response = await fetchOperator(
      app,
      post(
        "/admit-release-eval",
        { orgId: "org-1", userId: "user-1", run: { prompt: "probe" } },
        { authorization: `Bearer ${SECRET}`, "idempotency-key": "parity-1" },
      ),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ orgId: "org-1", userId: "user-1", prompt: "probe" });
    expect(calls.admit).toEqual([["org-1", "user-1"]]);
  });

  test("approves a gateway approval request through the canary hook", async () => {
    const { app, calls } = makeApp();
    const response = await fetchOperator(
      app,
      post(
        "/approve-gateway-request",
        { requestId: "req-1" },
        { authorization: `Bearer ${SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ approved: true });
    expect(calls.approve).toEqual(["req-1"]);
  });

  test("rejects a missing or wrong secret without touching the worker", async () => {
    const { app, calls } = makeApp();
    expect((await fetchOperator(app, post("/pump-thread", { threadId: "t" }))).status).toBe(401);
    expect(
      (
        await fetchOperator(
          app,
          post("/pump-thread", { threadId: "t" }, { authorization: "Bearer nope" }),
        )
      ).status,
    ).toBe(401);
    expect(calls.pump).toEqual([]);
  });

  test("cannot target another organization without the operator-only credential", async () => {
    const { app, calls } = makeApp();
    const response = await fetchOperator(
      app,
      post(
        "/admit-release-eval",
        { orgId: "other-org", userId: "other-user", run: { prompt: "cross-org" } },
        { authorization: "Bearer wrong-secret" },
      ),
    );
    expect(response.status).toBe(401);
    expect(calls.admit).toEqual([]);
  });

  test.each(["x-forwarded-for", "x-real-ip", "forwarded"])(
    "rejects a loopback request carrying the proxy-origin header %s",
    async (header) => {
      const { app, calls } = makeApp();
      const response = await fetchOperator(
        app,
        post("/pump-thread", { threadId: "t" }, {
          authorization: `Bearer ${SECRET}`,
          [header]: "203.0.113.9",
        }),
      );
      expect(response.status).toBe(404);
      expect(calls.pump).toEqual([]);
    },
  );

  test("rejects a non-loopback peer even with the correct secret and no forwarding headers", async () => {
    const { app, calls } = makeApp();
    const response = await fetchOperator(
      app,
      post("/pump-thread", { threadId: "t" }, { authorization: `Bearer ${SECRET}` }),
      "203.0.113.9",
    );
    expect(response.status).toBe(404);
    expect(calls.pump).toEqual([]);
  });

  test("rejects missing socket-peer evidence", async () => {
    const { app, calls } = makeApp();
    const response = await app.fetch(
      post("/pump-thread", { threadId: "t" }, { authorization: `Bearer ${SECRET}` }),
    );
    expect(response.status).toBe(404);
    expect(calls.pump).toEqual([]);
  });

  test("refuses to run with no secret configured", async () => {
    delete process.env.USEAGENT_OPERATOR_SECRET;
    const { app, calls } = makeApp();
    const response = await fetchOperator(app,
      post("/pump-thread", { threadId: "t" }, { authorization: "Bearer " }),
    );
    expect(response.status).toBe(401);
    expect(calls.pump).toEqual([]);
  });

  test("refuses a short or reused application-auth secret", async () => {
    const { app, calls } = makeApp();
    process.env.USEAGENT_OPERATOR_SECRET = "too-short";
    let response = await fetchOperator(
      app,
      post("/pump-thread", { threadId: "t" }, { authorization: "Bearer too-short" }),
    );
    expect(response.status).toBe(401);

    process.env.BETTER_AUTH_SECRET = SECRET;
    process.env.USEAGENT_OPERATOR_SECRET = SECRET;
    response = await fetchOperator(
      app,
      post("/pump-thread", { threadId: "t" }, { authorization: `Bearer ${SECRET}` }),
    );
    expect(response.status).toBe(401);
    expect(calls.pump).toEqual([]);
  });

  test("requires a threadId / runId / requestId", async () => {
    const { app } = makeApp();
    expect(
      (
        await fetchOperator(
          app,
          post("/pump-thread", {}, { authorization: `Bearer ${SECRET}` }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetchOperator(
          app,
          post("/signal-cancel", {}, { authorization: `Bearer ${SECRET}` }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetchOperator(
          app,
          post("/approve-gateway-request", {}, { authorization: `Bearer ${SECRET}` }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetchOperator(
          app,
          post("/admit-release-eval", { run: {} }, { authorization: `Bearer ${SECRET}` }),
        )
      ).status,
    ).toBe(400);
  });
});
