import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { installJsonErrorHandlers } from "./http-errors";

let logged: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  logged?.mockRestore();
  logged = null;
});

function app(): Hono {
  const app = new Hono();
  installJsonErrorHandlers(app, "test");
  app.get("/api/ok", (c) => c.json({ ok: true }));
  app.get("/api/boom", () => {
    throw new Error("unexpected database state");
  });
  app.get("/api/teapot", () => {
    throw new HTTPException(418, { message: "short and stout" });
  });
  // A mounted router with no handler of its own, the way index.ts mounts them.
  const nested = new Hono();
  nested.post("/explode", () => {
    throw new TypeError("cannot read properties of undefined");
  });
  app.route("/api/nested", nested);
  return app;
}

describe("installJsonErrorHandlers", () => {
  test("answers an unknown path with a JSON 404", async () => {
    const response = await app().request("/api/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  test("answers a thrown error with a JSON 500 and logs the method and path", async () => {
    logged = spyOn(console, "error").mockImplementation(() => {});

    const response = await app().request("/api/boom");

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(logged).toHaveBeenCalledTimes(1);
    const [line, error] = logged.mock.calls[0] as [string, Error];
    expect(line).toBe("[test] GET /api/boom failed:");
    expect(error.message).toBe("unexpected database state");
  });

  test("catches an error thrown inside a mounted router", async () => {
    logged = spyOn(console, "error").mockImplementation(() => {});

    const response = await app().request("/api/nested/explode", { method: "POST" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(logged.mock.calls[0]?.[0]).toBe("[test] POST /api/nested/explode failed:");
  });

  test("logs a path with the capability it carries scrubbed", async () => {
    logged = spyOn(console, "error").mockImplementation(() => {});
    const crashing = new Hono();
    installJsonErrorHandlers(crashing, "test");
    crashing.get("/api/port-proxy/:threadId/view/:capability/*", () => {
      throw new Error("proxy failed");
    });

    const response = await crashing.request("/api/port-proxy/t1/view/v1.eyJjbGFpbXMiOnt9fQ.c2lnbmF0dXJl/index.html");

    expect(response.status).toBe(500);
    expect(logged.mock.calls[0]?.[0]).toBe("[test] GET /api/port-proxy/t1/view/<redacted>/index.html failed:");
  });

  test("keeps the response an HTTPException carries", async () => {
    logged = spyOn(console, "error").mockImplementation(() => {});

    const response = await app().request("/api/teapot");

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("short and stout");
    expect(logged).not.toHaveBeenCalled();
  });

  test("leaves a route's own answer alone", async () => {
    const response = await app().request("/api/ok");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
