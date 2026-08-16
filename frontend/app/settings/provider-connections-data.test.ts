import { describe, expect, test } from "bun:test";
import {
  accountLabel,
  type CodexChatGptStatus,
  codexAccountLabel,
  codexAuthStatusLabel,
  codexLoginUrl,
  type ProviderConnectionMeta,
  providerConnectionViews,
  safeCodexChatGptLogin,
  safeCodexChatGptStatus,
  safeEnabledSandboxEngines,
  safeExternalAuthUrl,
  safeProviderConnections,
  safeProviderMetadata,
  statusLabel,
} from "./provider-connections-data";

const base = {
  id: "pc_1",
  status: "connected",
  metadata: {},
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  revokedAt: null,
} satisfies Omit<ProviderConnectionMeta, "provider" | "authMethod">;

describe("provider connection presentation", () => {
  test("builds a complete metadata-only provider view", () => {
    const views = providerConnectionViews([
      { ...base, provider: "openai", authMethod: "chatgpt_oauth" },
      { ...base, id: "pc_2", provider: "openrouter", authMethod: "api_key" },
    ]);

    expect(views).toEqual([
      {
        provider: "openai",
        apiKey: null,
        chatGptOAuth: { ...base, provider: "openai", authMethod: "chatgpt_oauth" },
      },
      { provider: "anthropic", apiKey: null, chatGptOAuth: null },
      {
        provider: "openrouter",
        apiKey: { ...base, id: "pc_2", provider: "openrouter", authMethod: "api_key" },
        chatGptOAuth: null,
      },
    ]);
  });

  test("trims optional account labels without adding empty metadata", () => {
    expect(safeProviderMetadata({ email: " user@example.com ", planType: " " })).toEqual({
      email: "user@example.com",
    });
  });

  test("renders account and status labels without secret material", () => {
    expect(accountLabel(null)).toBe("No account metadata");
    expect(
      accountLabel({
        ...base,
        provider: "anthropic",
        authMethod: "api_key",
        metadata: { planType: "Team" },
      }),
    ).toBe("Team");
    expect(statusLabel(null)).toBe("Not connected");
    expect(statusLabel({ ...base, provider: "openai", authMethod: "api_key" })).toBe("Connected");
  });

  test("accepts only browser-safe ChatGPT login URLs", () => {
    expect(safeExternalAuthUrl("https://chatgpt.com/auth")).toBe("https://chatgpt.com/auth");
    expect(safeExternalAuthUrl("http://localhost:1455/device")).toBe(
      "http://localhost:1455/device",
    );
    expect(safeExternalAuthUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalAuthUrl("not a url")).toBeNull();

    expect(
      codexLoginUrl({
        type: "chatgpt",
        loginId: "login_1",
        authUrl: "https://chatgpt.com/login",
      }),
    ).toBe("https://chatgpt.com/login");
    expect(
      codexLoginUrl({
        type: "chatgptDeviceCode",
        loginId: "login_2",
        verificationUrl: "https://chatgpt.com/activate",
        userCode: "ABCD-EFGH",
      }),
    ).toBe("https://chatgpt.com/activate");
  });

  test("renders Codex account status from server status before stored metadata", () => {
    const status = {
      account: {
        authMode: "chatgpt",
        email: "gpt@example.com",
        planType: "Pro",
      },
      requiresOpenaiAuth: false,
    } satisfies CodexChatGptStatus;
    const stored = {
      ...base,
      provider: "openai",
      authMethod: "chatgpt_oauth",
      metadata: { email: "older@example.com", planType: "Team" },
    } satisfies ProviderConnectionMeta;

    expect(codexAccountLabel(status, stored)).toBe("gpt@example.com");
    expect(codexAuthStatusLabel(status, stored)).toBe("Connected");
    expect(codexAccountLabel(null, stored)).toBe("older@example.com");
    expect(codexAuthStatusLabel({ account: null, requiresOpenaiAuth: true }, null)).toBe(
      "Reauth required",
    );
    expect(codexAuthStatusLabel(null, { ...stored, status: "revoked" })).toBe("Revoked");
  });

  test("retains only browser-safe provider connection metadata", () => {
    const connections = safeProviderConnections([
      {
        ...base,
        provider: "openai",
        authMethod: "chatgpt_oauth",
        metadata: {
          email: "user@example.com",
          planType: "Plus",
          codexHome: "/srv/codex/user",
          accessToken: "secret-token",
        },
        credentialCiphertext: "encrypted-secret",
      },
      { ...base, provider: "unknown", authMethod: "api_key" },
    ]);

    expect(connections).toEqual([
      {
        ...base,
        provider: "openai",
        authMethod: "chatgpt_oauth",
        metadata: { email: "user@example.com", planType: "Plus" },
      },
    ]);
    expect(JSON.stringify(connections)).not.toContain("codexHome");
    expect(JSON.stringify(connections)).not.toContain("accessToken");
    expect(JSON.stringify(connections)).not.toContain("credentialCiphertext");
  });

  test("keeps account lifecycle metadata separate from sandbox engine enablement", () => {
    expect(
      safeCodexChatGptLogin({
        type: "chatgpt",
        loginId: "login_1",
        authUrl: "https://chatgpt.com/login",
        accessToken: "secret-token",
      }),
    ).toEqual({
      type: "chatgpt",
      loginId: "login_1",
      authUrl: "https://chatgpt.com/login",
    });
    expect(
      safeCodexChatGptLogin({
        type: "chatgpt",
        loginId: "login_2",
        authUrl: "javascript:alert(1)",
      }),
    ).toBeNull();

    const status = safeCodexChatGptStatus({
      account: {
        authMode: "chatgpt",
        email: "user@example.com",
        planType: "Plus",
        codexHome: "/srv/codex/user",
      },
      requiresOpenaiAuth: false,
      accessToken: "secret-token",
      sandboxExecutionEnabled: true,
    });

    expect(status).toEqual({
      account: {
        authMode: "chatgpt",
        email: "user@example.com",
        planType: "Plus",
      },
      requiresOpenaiAuth: false,
    });
    expect(safeEnabledSandboxEngines(["opencode", "codex", 42, null, "codex"])).toEqual([
      "opencode",
      "codex",
    ]);
  });
});
