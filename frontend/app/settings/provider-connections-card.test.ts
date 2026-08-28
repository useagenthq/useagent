import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderConnectionPanel } from "./provider-connection-panel";
import { ProviderConnectionsCard } from "./provider-connections-card";
import type { ProviderConnectionMeta } from "./provider-connections-data";

test("renders the provider connection summary and loading state before client effects", () => {
  const html = renderToStaticMarkup(createElement(ProviderConnectionsCard));

  expect(html).toContain("0 of 3 providers connected");
  expect(html).toContain("Loading provider connections...");
  expect(html).toContain(">Refresh<");
  expect(html).not.toContain("Updates refresh from the org event stream");
});

test("renders OpenAI connected when OAuth is active and an old API key is revoked", () => {
  const base = {
    metadata: {},
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    revokedAt: null,
    provider: "openai",
  } satisfies Omit<ProviderConnectionMeta, "id" | "authMethod" | "status">;
  const html = renderToStaticMarkup(
    createElement(ProviderConnectionPanel, {
      provider: "openai",
      connection: {
        ...base,
        id: "pc_api",
        authMethod: "api_key",
        status: "revoked",
      },
      oauthConnection: {
        ...base,
        id: "pc_oauth",
        authMethod: "chatgpt_oauth",
        status: "connected",
      },
      codexSandboxExecutionEnabled: true,
      onSaved: async () => {},
    }),
  );
  const apiKeyRow = html.indexOf("API key");

  expect(apiKeyRow).toBeGreaterThan(0);
  expect(html.slice(0, apiKeyRow)).toContain("Connected");
  expect(html.slice(0, apiKeyRow)).not.toContain("Revoked");
  expect(html.slice(apiKeyRow)).toContain("Revoked");
});
