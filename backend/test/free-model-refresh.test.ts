import { afterEach, describe, expect, test } from "bun:test";
import { isPublicApiPath } from "../src/middleware/org";
import {
  freeModelLaneCache,
  setFreeModelCatalogFetcherForTest,
} from "../src/runs/free-model-lane";
import { createOrgSession, json } from "./helpers";

// POST /api/config/models/refresh - the picker's manual Free-lane refresh.
// Pins: org-session auth (fail-closed adapter coverage), the TTL bust (a fresh
// catalog lands in the response AND the public manifest), and the cool-down
// rate limit. The catalog fetcher is a fixture - no live network.

afterEach(() => {
  // Restore the networkless preload stub + cold seed state for other suites.
  setFreeModelCatalogFetcherForTest(async () => new Response(null, { status: 503 }));
  freeModelLaneCache.reset();
});

describe("manual free-model refresh endpoint", () => {
  test("is org-scoped by the universal adapter, never public", () => {
    expect(isPublicApiPath("/api/config/models/refresh")).toBe(false);
  });

  test("busts the catalog cache, then rate-limits an immediate repeat", async () => {
    const org = await createOrgSession("free-refresh");
    // Cold-start the shared cache so no earlier suite's background kick (or its
    // failure cool-down) races this test's forced refresh.
    freeModelLaneCache.reset();
    setFreeModelCatalogFetcherForTest(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "vendor/fresh-model:free",
              context_length: 200_000,
              supported_parameters: ["tools", "temperature"],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const first = await json<{
      refreshed: boolean;
      free: string[];
      models: Record<string, string[]>;
    }>("/api/config/models/refresh", { method: "POST", cookies: org.cookies });
    expect(first.status).toBe(200);
    expect(first.body.refreshed).toBe(true);
    expect(first.body.free).toEqual(["vendor/fresh-model:free"]);
    expect(first.body.models.opencode).toContain("vendor/fresh-model:free");

    // The public manifest now advertises the refreshed lane too.
    const manifest = await json<{ models: Record<string, string[]> }>("/api/config");
    expect(manifest.status).toBe(200);
    expect(manifest.body.models.opencode).toContain("vendor/fresh-model:free");

    // An immediate second manual refresh is inside the cool-down.
    const second = await json<{ error: string; retry_after_ms: number }>(
      "/api/config/models/refresh",
      { method: "POST", cookies: org.cookies },
    );
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("rate_limited");
    expect(second.body.retry_after_ms).toBeGreaterThan(0);
  });
});
