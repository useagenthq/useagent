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

  test("refreshes the free lane and the actor-scoped native capability catalog", async () => {
    const seen: { url: string; method?: string }[] = [];
    const catalog = await requestModelCatalogRefresh(async (url, init) => {
      seen.push({ url, method: init?.method });
      if (url === "/api/config/models/refresh") return jsonResponse({ refreshed: true });
      return jsonResponse({
        version: 1,
        scope: "pre_run",
        bots: false,
        engines: [{
          id: "codex",
          configured: true,
          ready: true,
          defaultModel: "gpt-5.6-luna",
          models: [
            {
              id: "gpt-6-astra",
              displayName: "GPT-6 Astra",
              default: false,
              dispatchable: true,
              policyAllowed: true,
              nativeAvailable: true,
            },
            {
              id: "gpt-future-native",
              displayName: "Future Native",
              default: false,
              dispatchable: false,
              policyAllowed: false,
              nativeAvailable: true,
              degradationReason: "model_not_allowed",
            },
          ],
          modelCatalog: { source: "native", stale: false },
          runtime: { kind: "t3", label: "OpenAI agent" },
        }],
        tools: { gatewayConfigured: false, declared: [] },
        nativeSlashCommands: { catalog: "session_runtime", currentRun: null },
      });
    });
    expect(seen).toEqual([
      { url: "/api/config/models/refresh", method: "POST" },
      { url: "/api/capabilities?refresh=models", method: undefined },
    ]);
    expect(catalog).toEqual({
      models: { codex: ["gpt-6-astra"] },
      modelDetails: {
        codex: [
          expect.objectContaining({ id: "gpt-6-astra", dispatchable: true }),
          expect.objectContaining({ id: "gpt-future-native", dispatchable: false }),
        ],
      },
      modelCatalogStatuses: { codex: { source: "native", stale: false } },
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

  test("a Codex-only refresh does not call the shared Free-lane endpoint", async () => {
    const seen: string[] = [];
    await requestModelCatalogRefresh(async (url) => {
      seen.push(url);
      return jsonResponse({
        version: 1,
        scope: "pre_run",
        bots: false,
        engines: [],
        tools: { gatewayConfigured: false, declared: [] },
        nativeSlashCommands: { catalog: "session_runtime", currentRun: null },
      });
    }, { refreshFree: false });
    expect(seen).toEqual(["/api/capabilities?refresh=models"]);
  });

  test("an empty capability catalog parses without inventing models", async () => {
    let call = 0;
    expect(
      await requestModelCatalogRefresh(async () => {
        call += 1;
        if (call === 1) return jsonResponse({ refreshed: true });
        return jsonResponse({
          version: 1,
          scope: "pre_run",
          bots: false,
          engines: [],
          tools: { gatewayConfigured: false, declared: [] },
          nativeSlashCommands: { catalog: "session_runtime", currentRun: null },
        });
      }),
    ).toEqual({ models: {}, modelDetails: {}, modelCatalogStatuses: {} });
  });
});
