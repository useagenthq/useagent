import { describe, expect, test } from "bun:test";
import { createOrgSession, fetchApi } from "./helpers";

// The backend app's last-resort answers, through the real app and auth adapter
// (src/http-errors.ts installed in src/index.ts).
describe("unknown API paths", () => {
  test("a signed-in GET of a path no router serves answers a JSON 404", async () => {
    const session = await createOrgSession("api-not-found");

    for (const path of ["/api/does-not-exist", "/api/runs/abc/no-such-view"]) {
      const response = await fetchApi(path, { cookies: session.cookies });
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });
});
