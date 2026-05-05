import { describe, expect, test } from "bun:test";
import { json } from "./helpers";

describe("health", () => {
  test("GET /api/health → {status:'ok'}", async () => {
    const { status, body } = await json("/api/health");
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });
});
