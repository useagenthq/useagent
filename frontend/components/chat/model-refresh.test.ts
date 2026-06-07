import { describe, expect, test } from "bun:test";
import {
  mergeEngineModelCatalog,
  parseEngineReadinessCatalog,
  requestModelCatalogRefresh,
} from "@/components/chat/engine-picker";

// The picker's "Refresh free models" affordance: POST the manual-refresh
// endpoint, parse the refreshed per-engine manifest, and hand it back for an
// in-place catalog swap. Failure modes (rate limit, backend down, garbage)
// return null so the picker keeps its current list. Fetcher injected - no
// network.

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("requestModelCatalogRefresh", () => {
  test("preserves configured-but-unready engine diagnostics", () => {
    expect(parseEngineReadinessCatalog({
      claude: {
        ready: false,
        reason: "provider_unhealthy",
        provider: "anthropic",
        providerHealth: "insufficient_credit",
        message: "Add credits in Settings, then retry.",
      },
      bogus: { ready: false, reason: "provider_unhealthy" },
    })).toEqual({
      claude: {
        ready: false,
        reason: "provider_unhealthy",
        provider: "anthropic",
        providerHealth: "insufficient_credit",
        message: "Add credits in Settings, then retry.",
      },
    });
  });

  test("merges a rotated lane without invalidating an already selected model", () => {
    expect(
      mergeEngineModelCatalog(
        { opencode: ["old/paid", "vendor/old:free"], codex: ["old-codex"] },
        { opencode: ["new/paid", "vendor/new:free"], codex: ["new-codex"] },
        "vendor/old:free",
      ),
    ).toEqual({
      opencode: ["new/paid", "vendor/new:free", "vendor/old:free"],
      codex: ["new-codex"],
    });
  });

  test("POSTs the refresh endpoint and returns the parsed manifest", async () => {
    const seen: { url: string; method?: string }[] = [];
    const catalog = await requestModelCatalogRefresh(async (url, init) => {
      seen.push({ url, method: init?.method });
      return jsonResponse({
        refreshed: true,
        free: ["newvendor/brand-new-model:free"],
        models: {
          opencode: ["openai/gpt-5.6-luna", "newvendor/brand-new-model:free"],
          chat: ["anthropic/claude-sonnet-5"],
          bogus: ["ignored"],
        },
      });
    });
    expect(seen).toEqual([{ url: "/api/config/models/refresh", method: "POST" }]);
    expect(catalog).toEqual({
      opencode: ["openai/gpt-5.6-luna", "newvendor/brand-new-model:free"],
      chat: ["anthropic/claude-sonnet-5"],
    });
  });

  test("rate-limited, failed, and malformed responses return null (keep current list)", async () => {
    expect(
      await requestModelCatalogRefresh(async () =>
        jsonResponse({ error: "rate_limited", retry_after_ms: 12_000 }, 429),
      ),
    ).toBeNull();
    expect(
      await requestModelCatalogRefresh(async () => new Response(null, { status: 503 })),
    ).toBeNull();
    expect(
      await requestModelCatalogRefresh(async () => {
        throw new Error("backend down");
      }),
    ).toBeNull();
    expect(
      await requestModelCatalogRefresh(
        async () => new Response("<html>not json</html>", { status: 200 }),
      ),
    ).toBeNull();
  });

  test("a manifest without model arrays parses to an empty catalog, not a crash", async () => {
    expect(
      await requestModelCatalogRefresh(async () => jsonResponse({ refreshed: true })),
    ).toEqual({});
    expect(
      await requestModelCatalogRefresh(async () =>
        jsonResponse({ models: { opencode: "not-an-array" } }),
      ),
    ).toEqual({});
  });
});
