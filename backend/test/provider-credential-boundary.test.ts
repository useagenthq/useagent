import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const agentTurnFiles = [
  "src/engines/acp-server.ts",
  "src/engines/opencode-server.ts",
  "src/engines/sandbox.ts",
  "src/engines/t3-adapter.ts",
] as const;

const sourceFor = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function backendExecutionSource(path: (typeof agentTurnFiles)[number], source: string): string {
  if (path !== "src/engines/acp-server.ts") return source;
  const withoutSandboxRelay = source.replace(
    /export const RELAY_SCRIPT = `[\s\S]*?^`;/m,
    "",
  );
  if (withoutSandboxRelay === source) throw new Error("missing in-sandbox ACP relay source");
  return withoutSandboxRelay;
}

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
  for (const path of agentTurnFiles) {
    test(`${path} cannot read or inject backend provider credentials`, () => {
      const source = sourceFor(path);
      const backendSource = backendExecutionSource(path, source);
      for (const name of providerSecretNames) {
        expect(backendSource).not.toMatch(
          new RegExp(`(?:process\\.env|\\benv)(?:\\.${name}|\\[["']${name}["']\\])`),
        );
      }
      expect(backendSource).not.toMatch(
        /env\s*:\s*process\.env\b|\.\.\.\s*process\.env\b|\b(?:childEnv|hostProviderEnv)\(/,
      );
      expect(source).toMatch(
        /composeSecretEnv\(ctx,\s*\{\s*excludeNames:\s*PROVIDER_SECRET_NAMES\s*,?\s*\}\)/,
      );
    });
  }

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
    expect(inheritedKeys).toEqual(["PATH"]);
    expect(source).toMatch(
      /spawn\("codex", \["app-server", "--stdio"\], \{[\s\S]*?env: codexAppServerChildEnvironment\(input\.codexHome\),/,
    );
    expect(source.match(/\bspawn\(/g)).toHaveLength(1);

    const childEnvironment = source.match(
      /export function codexAppServerChildEnvironment\([\s\S]*?\n\}/,
    )?.[0];
    expect(childEnvironment).toBeDefined();
    expect(childEnvironment).toContain("{ CODEX_HOME: codexHome }");
    expect(childEnvironment).toContain("for (const key of CODEX_APP_SERVER_ENV_KEYS)");
    expect(childEnvironment).not.toMatch(/\.\.\.(?:process\.env|env)\b/);

    for (const name of providerSecretNames) {
      expect(source).not.toMatch(
        new RegExp(`process\\.env(?:\\.${name}|\\[["']${name}["']\\])`),
      );
    }
  });
});
