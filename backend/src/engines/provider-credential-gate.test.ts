import { describe, expect, test } from "bun:test";
import {
  assertRunProviderCredential,
  providerCredentialMissingMessage,
} from "./provider-credential-gate";

const env = { NODE_ENV: "production", USEAGENT_DEV_MODE: "false" };

describe("provider credential gate", () => {
  test("a keyless Claude run fails before any sandbox with the remedy named", async () => {
    const asked: unknown[] = [];
    await expect(assertRunProviderCredential(
      "claude",
      { orgId: "org-a", userId: "user-a", model: "claude-opus-5" },
      { env, resolve: async (input) => { asked.push(input); return null; } },
    )).rejects.toThrow(
      "Claude Code cannot start: no Anthropic key is connected for this organization. " +
        "Connect an Anthropic key in Settings, then retry.",
    );
    expect(asked).toEqual([{ orgId: "org-a", userId: "user-a", provider: "anthropic", model: "claude-opus-5" }]);
  });

  test("a connected key lets the run proceed", async () => {
    await expect(assertRunProviderCredential(
      "opencode",
      { orgId: "org-a", userId: "user-a", model: "deepseek/deepseek-v4-flash" },
      { env, resolve: async () => ({ value: "k", source: "user_connection" }) },
    )).resolves.toBeUndefined();
  });

  test("the engine default model decides the provider when the run has none", async () => {
    const asked: { provider: string; model?: string | null }[] = [];
    await assertRunProviderCredential(
      "opencode",
      { orgId: "org-a", userId: null, model: "" },
      { env, resolve: async (input) => { asked.push(input); return { value: "k", source: "org_secret" }; } },
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]!.model).toBeTruthy();
  });

  test("subscription-only fails early while hybrid falls back to the provider gateway", async () => {
    let resolved = 0;
    const resolve = async () => { resolved += 1; return { value: "k", source: "org_secret" as const }; };
    await expect(assertRunProviderCredential(
      "codex",
      { orgId: "org-a", userId: "u", model: "gpt-6-astra" },
      {
        env: { ...env, ENGINE_AUTH_MODE_CODEX: "subscription" },
        resolve,
        resolveSubscription: async () => null,
      },
    )).rejects.toThrow("no connected Codex account");
    await assertRunProviderCredential(
      "codex",
      { orgId: "org-a", userId: "u", model: "gpt-6-astra" },
      {
        env: { ...env, ENGINE_AUTH_MODE_CODEX: "hybrid" },
        resolve,
        resolveSubscription: async () => null,
      },
    );
    await assertRunProviderCredential("claude", { orgId: null, userId: "u", model: "claude-opus-5" }, { env, resolve });
    await assertRunProviderCredential("mock", { orgId: "org-a", userId: "u", model: "" }, { env, resolve });
    expect(resolved).toBe(1);
  });

  test("a connected subscription avoids the provider gateway", async () => {
    let resolved = 0;
    await expect(assertRunProviderCredential(
      "codex",
      { orgId: "org-a", userId: "u", model: "gpt-6-astra" },
      {
        env: { ...env, ENGINE_AUTH_MODE_CODEX: "subscription" },
        resolve: async () => { resolved += 1; return null; },
        resolveSubscription: async () => ({
          authMethod: "chatgpt_oauth",
          mode: "managed_codex_app_server",
          connectionId: "connection-a",
          authEpoch: "epoch-a",
          codexHome: "/private/codex-home",
          metadata: {},
        }),
      },
    )).resolves.toBeUndefined();
    expect(resolved).toBe(0);
  });

  test("the message is engine and provider specific", () => {
    expect(providerCredentialMissingMessage("pi", "openrouter")).toContain("Pi cannot start: no OpenRouter key");
    expect(providerCredentialMissingMessage("pi", "openrouter")).toContain("Connect an OpenRouter key in Settings, then retry.");
  });
});
