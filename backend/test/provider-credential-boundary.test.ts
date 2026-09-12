import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const agentTurnFiles = [
  "src/engines/runtime-adapter.ts",
  "src/engines/pi-adapter.ts",
] as const;

const sourceFor = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function stringLiteralsIn(source: string, declaration: RegExp): string[] {
  const body = declaration.exec(source)?.groups?.body;
  if (body === undefined) throw new Error(`missing source declaration: ${declaration.source}`);
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

const secretBoundarySource = sourceFor("src/secrets/inject.ts");
const providerSecretNames = stringLiteralsIn(
  secretBoundarySource,
  /export const PROVIDER_SECRET_NAMES = new Set\(\[(?<body>[\s\S]*?)\]\);/,
);

describe("provider credential trust boundary", () => {
  const sharedPreparation = sourceFor("src/engines/sandbox-turn-preparation.ts");

  for (const path of agentTurnFiles) {
    test(`${path} cannot read or inject backend provider credentials`, () => {
      const source = sourceFor(path);
      // The in-sandbox relay (which legitimately inherits the sandbox env) lives in
      // acp-relay-script.ts, so every agent-turn file is scanned whole.
      const backendSource = source;
      for (const name of providerSecretNames) {
        expect(backendSource).not.toMatch(
          new RegExp(`(?:process\\.env|\\benv)(?:\\.${name}|\\[["']${name}["']\\])`),
        );
      }
      expect(backendSource).not.toMatch(
        /env\s*:\s*process\.env\b|\.\.\.\s*process\.env\b|\b(?:childEnv|hostProviderEnv)\(/,
      );
      if (source.includes("prepareSandboxTurn")) {
        expect(source).toContain('from "./sandbox-turn-preparation"');
      } else {
        expect(source).toMatch(
          /composeSecretEnv\(ctx,\s*\{\s*excludeNames:\s*PROVIDER_SECRET_NAMES\s*,?\s*\}\)/,
        );
      }
    });
  }

  test("shared sandbox preparation owns lease acquisition and provider-secret exclusion", () => {
    expect(sharedPreparation).toContain("acquireThreadSandbox(ctx");
    expect(sharedPreparation).toMatch(
      /composeSecretEnv\(ctx,\s*\{\s*excludeNames:\s*PROVIDER_SECRET_NAMES\s*,?\s*\}\)/,
    );
  });

  test("every paid sandbox adapter fails closed without the gateway", () => {
    for (const path of agentTurnFiles) {
      const source = sourceFor(path);
      expect(source).toContain("requires a configured provider gateway");
    }
  });

  test("Codex app-server stays auth-only and inherits only its child allowlist", () => {
    const source = sourceFor("src/provider-connections/codex-app-server.ts");
    const accountMethods = stringLiteralsIn(
      source,
      /const CODEX_APP_SERVER_ACCOUNT_METHODS = \[(?<body>[\s\S]*?)\] as const;/,
    );
    const inheritedKeys = stringLiteralsIn(
      source,
      /const CODEX_APP_SERVER_ENV_KEYS = \[(?<body>[\s\S]*?)\] as const;/,
    );

    expect(accountMethods).toEqual([
      "account/login/start",
      "account/login/cancel",
      "account/read",
      "account/logout",
    ]);
    expect(inheritedKeys).toEqual(["PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]);
    expect(source).toMatch(
      /spawn\("codex", \["app-server", "--stdio"\], \{[\s\S]*?env: codexAppServerChildEnvironment\(input\.codexHome\),/,
    );
    expect(source.match(/\bspawn\(/g)).toHaveLength(1);

    const childEnvironment = source.match(
      /export function codexAppServerChildEnvironment\([\s\S]*?\n\}/,
    )?.[0];
    expect(childEnvironment).toBeDefined();
    expect(childEnvironment).toContain("CODEX_HOME: codexHome");
    expect(childEnvironment).toContain("HOME: codexHome");
    expect(childEnvironment).toContain("for (const key of CODEX_APP_SERVER_ENV_KEYS)");
    expect(childEnvironment).not.toMatch(/\.\.\.(?:process\.env|env)\b/);

    for (const name of providerSecretNames) {
      expect(source).not.toMatch(
        new RegExp(`process\\.env(?:\\.${name}|\\[["']${name}["']\\])`),
      );
    }
  });

  test("provider gateway resolves only API-key credentials through its restricted view", () => {
    const gatewayCredentials = sourceFor("src/provider-gateway/credentials.ts");
    const gatewayApiKeyResolver = sourceFor("src/provider-gateway/api-key-credentials.ts");

    expect(gatewayCredentials).not.toContain("../provider-connections/service");
    expect(gatewayApiKeyResolver).toContain("gateway_provider_api_key_credentials");
    expect(gatewayApiKeyResolver).toContain("auth_method = 'api_key'");
    expect(gatewayApiKeyResolver).toContain("authMethod !== \"api_key\"");
    expect(gatewayApiKeyResolver).not.toContain("provider_connections");
    expect(gatewayApiKeyResolver).not.toContain("chatgpt_oauth");
  });

  test("T3 sandbox execution cannot materialize managed Codex OAuth state", () => {
    const sandboxExecutionSources = [
      sourceFor("src/engines/runtime-adapter.ts"),
      sourceFor("src/engines/runtime-provider-bridge.ts"),
    ].join("\n");

    for (const forbidden of [
      "codexHome",
      "accessToken",
      "refreshToken",
      "chatgptAuthTokens",
      ".codex/auth.json",
      "account/login/start",
      "account/chatgptAuthTokens/refresh",
    ]) {
      expect(sandboxExecutionSources).not.toContain(forbidden);
    }
  });
});
