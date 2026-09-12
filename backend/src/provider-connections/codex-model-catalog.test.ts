import { afterEach, describe, expect, test } from "bun:test";
import {
  nativeCodexModelCatalog,
  resetNativeCodexModelCatalogForTest,
} from "./codex-model-catalog";

const scope = { orgId: "org-models", userId: "user-models" };

afterEach(resetNativeCodexModelCatalogForTest);

describe("actor-scoped Codex model discovery", () => {
  test("pages the native catalog, filters hidden entries, and keeps capability metadata", async () => {
    const calls: Array<{ scope: typeof scope; cursor?: string }> = [];
    const result = await nativeCodexModelCatalog(scope, {
      force: true,
      dependencies: {
        now: () => 1_000,
        runtimeSelection: async () => ({
          authMethod: "chatgpt_oauth",
          mode: "managed_codex_app_server",
          connectionId: "connection-models",
          authEpoch: "epoch-models",
          codexHome: "/private/codex-home",
          metadata: {},
        }),
        listModels: async (actor, params) => {
          calls.push({ scope: actor, ...(params.cursor ? { cursor: params.cursor } : {}) });
          return params.cursor
            ? {
                data: [{
                  id: "gpt-6-astra",
                  model: "gpt-6-astra",
                  displayName: "GPT-6 Astra",
                  hidden: false,
                  defaultReasoningEffort: "high",
                  supportedReasoningEfforts: [
                    { reasoningEffort: "low" },
                    { reasoningEffort: "max" },
                    { reasoningEffort: "invalid" },
                  ],
                }],
                nextCursor: null,
              }
            : {
                data: [
                  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", hidden: false },
                  { id: "hidden-model", displayName: "Hidden", hidden: true },
                ],
                nextCursor: "page-2",
              };
        },
      },
    });

    expect(calls).toEqual([{ scope }, { scope, cursor: "page-2" }]);
    expect(result).toEqual({
      status: "native",
      stale: false,
      models: [
        {
          id: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          supportedReasoningEfforts: [],
        },
        {
          id: "gpt-6-astra",
          displayName: "GPT-6 Astra",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: ["low", "max"],
        },
      ],
    });
  });

  test("keeps last-known-good only for the same actor credential epoch", async () => {
    let now = 1_000;
    let authEpoch = "epoch-a";
    let fail = false;
    let connected = true;
    const dependencies = {
      now: () => now,
      runtimeSelection: async () => connected ? ({
        authMethod: "chatgpt_oauth" as const,
        mode: "managed_codex_app_server" as const,
        connectionId: "connection-models",
        authEpoch,
        codexHome: "/private/codex-home",
        metadata: {},
      }) : null,
      listModels: async () => {
        if (fail) throw new Error("catalog unavailable");
        return {
          data: [{ id: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: false }],
          nextCursor: null,
        };
      },
    };

    expect((await nativeCodexModelCatalog(scope, { dependencies, force: true })).stale).toBe(false);
    now += 6 * 60_000;
    fail = true;
    const stale = await nativeCodexModelCatalog(scope, { dependencies, force: true });
    expect(stale.models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
    expect(stale).toMatchObject({ status: "native", stale: true });

    authEpoch = "epoch-b";
    const rotated = await nativeCodexModelCatalog(scope, { dependencies, force: true });
    expect(rotated).toEqual({
      models: [],
      status: "unavailable",
      stale: true,
      error: "native_catalog_unavailable",
    });

    authEpoch = "epoch-c";
    fail = false;
    await nativeCodexModelCatalog(scope, { dependencies, force: true });
    connected = false;
    expect(await nativeCodexModelCatalog(scope, { dependencies })).toMatchObject({
      models: [],
      status: "unavailable",
      error: "not_connected",
    });
    connected = true;
    fail = true;
    expect(await nativeCodexModelCatalog(scope, { dependencies, force: true })).toMatchObject({
      models: [],
      status: "unavailable",
      error: "native_catalog_unavailable",
    });
  });

  test("normal catalog reads return immediately while one actor refresh runs", async () => {
    let resolvePage!: (value: unknown) => void;
    const page = new Promise<unknown>((resolve) => { resolvePage = resolve; });
    const dependencies = {
      now: () => 1_000,
      runtimeSelection: async () => ({
        authMethod: "chatgpt_oauth" as const,
        mode: "managed_codex_app_server" as const,
        connectionId: "connection-models",
        authEpoch: "epoch-models",
        codexHome: "/private/codex-home",
        metadata: {},
      }),
      listModels: async () => page,
    };

    await expect(nativeCodexModelCatalog(scope, { dependencies })).resolves.toEqual({
      models: [],
      status: "unavailable",
      stale: true,
      error: "native_catalog_refreshing",
    });
    await expect(nativeCodexModelCatalog(scope, { dependencies })).resolves.toEqual({
      models: [],
      status: "unavailable",
      stale: true,
      error: "native_catalog_refreshing",
    });
    resolvePage({ data: [], nextCursor: null });
    await Bun.sleep(0);
    await expect(nativeCodexModelCatalog(scope, { dependencies })).resolves.toEqual({
      models: [],
      status: "native",
      stale: false,
    });
  });

  test("expires old actors and bounds the actor cache", async () => {
    let now = 1_000;
    const failingActors = new Set<string>();
    const dependencies = {
      now: () => now,
      runtimeSelection: async (actor: typeof scope) => ({
        authMethod: "chatgpt_oauth" as const,
        mode: "managed_codex_app_server" as const,
        connectionId: `connection-${actor.userId}`,
        authEpoch: `epoch-${actor.userId}`,
        codexHome: `/private/${actor.userId}`,
        metadata: {},
      }),
      listModels: async (actor: typeof scope) => {
        if (failingActors.has(actor.userId)) throw new Error("catalog unavailable");
        return {
          data: [{ id: `model-${actor.userId}`, hidden: false }],
          nextCursor: null,
        };
      },
    };

    for (let index = 0; index < 257; index += 1) {
      await nativeCodexModelCatalog(
        { orgId: "org-models", userId: `user-${index}` },
        { dependencies, force: true },
      );
    }
    failingActors.add("user-0");
    expect(await nativeCodexModelCatalog(
      { orgId: "org-models", userId: "user-0" },
      { dependencies, force: true },
    )).toMatchObject({ models: [], status: "unavailable" });

    failingActors.add("user-256");
    now += 61 * 60_000;
    expect(await nativeCodexModelCatalog(
      { orgId: "org-models", userId: "user-256" },
      { dependencies, force: true },
    )).toMatchObject({ models: [], status: "unavailable" });
  });
});
