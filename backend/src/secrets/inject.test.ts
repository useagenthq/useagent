import { describe, expect, test } from "bun:test";
import type { DecryptedSecrets } from "./store";
import {
  buildInjection,
  isProtectedInjectedSecretPath,
  materializeSecretInjection,
  PROVIDER_SECRET_NAMES,
  sandboxSecretMode,
  sandboxSecretSourceCommand,
  SECRET_DOTENV_PATH,
  SECRET_FILE_DIR,
} from "./inject";
import { SANDBOX_NAME_PREFIX, SANDBOX_STATE_DIR } from "../sandboxes/sandbox-names";

const decrypted: DecryptedSecrets = {
  secrets: [
    { name: "CUSTOM_TOKEN", kind: "env", value: "custom-secret-value" },
    { name: "CUSTOM_CERT", kind: "file", value: "custom-file-value" },
    { name: "OPENAI_API_KEY", kind: "env", value: "provider-secret-value" },
  ],
  names: ["CUSTOM_TOKEN", "CUSTOM_CERT", "OPENAI_API_KEY"],
  skipped: [],
};

describe("injected secret path protection", () => {
  test("rejects non-canonical configured directories before materialization", () => {
    for (const directory of [
      "/root/work/secret-staging/../custom-secrets",
      "$HOME/work/../.custom/secrets",
      "/root/..",
      "$HOME/../secrets",
      "$HOME/./secrets",
    ]) {
      const child = Bun.spawnSync([
        process.execPath,
        "--eval",
        `await import(${JSON.stringify(new URL("./inject.ts", import.meta.url).href)});`,
      ], {
        env: { ...process.env, SECRETS_FILE_DIR: directory },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });
      expect(child.exitCode).not.toBe(0);
      expect(child.stderr.toString()).toContain("SECRETS_FILE_DIR must not contain . or .. path components");
    }
  });

  test("protects canonical, legacy, and configured directories together", () => {
    for (const namespace of [".useagent", SANDBOX_STATE_DIR]) {
      for (const home of ["$HOME", "~", "/root", "/home/daytona"]) {
        const directory = `${home}/${namespace}/secrets`;
        expect(isProtectedInjectedSecretPath(directory)).toBe(true);
        expect(isProtectedInjectedSecretPath(`${directory}/credential.json`)).toBe(true);
        expect(isProtectedInjectedSecretPath(`${home}/work/../${namespace}/secrets/key`)).toBe(true);
      }
    }
    expect(isProtectedInjectedSecretPath(SECRET_FILE_DIR)).toBe(true);
    expect(isProtectedInjectedSecretPath(`${SECRET_FILE_DIR}/credential.json`)).toBe(true);
    expect(isProtectedInjectedSecretPath("\\root\\.useagent\\secrets\\key")).toBe(true);
    expect(isProtectedInjectedSecretPath("/root/work/.env.production")).toBe(true);
  });

  test("keeps sibling directories and ordinary deliverables publishable", () => {
    for (const namespace of [".useagent", SANDBOX_STATE_DIR]) {
      expect(isProtectedInjectedSecretPath(`/root/${namespace}/secrets-backup/report.pdf`)).toBe(false);
      expect(isProtectedInjectedSecretPath(`/home/daytona/${namespace}/artifacts/report.pdf`)).toBe(false);
    }
    expect(isProtectedInjectedSecretPath("/root/work/report.pdf")).toBe(false);
    expect(isProtectedInjectedSecretPath("/root/work/.environment.txt")).toBe(false);
    expect(isProtectedInjectedSecretPath(`${SECRET_FILE_DIR}-backup/report.pdf`)).toBe(false);
  });
});

describe("sandbox secret delivery mode", () => {
  test("defaults production to gateway-only while development keeps compatibility", () => {
    expect(sandboxSecretMode({ NODE_ENV: "production" })).toBe("gateway_only");
    expect(sandboxSecretMode({ NODE_ENV: "development" })).toBe("compatibility");
    expect(
      () =>
        sandboxSecretMode({
          NODE_ENV: "production",
          USEAGENT_DEV_MODE: "true",
          SANDBOX_SECRET_MODE: "compatibility",
        }),
    ).toThrow("SANDBOX_SECRET_MODE=compatibility is forbidden outside development");
    expect(
      sandboxSecretMode({
        NODE_ENV: "development",
        SANDBOX_SECRET_MODE: "compatibility",
      }),
    ).toBe("compatibility");
    expect(
      sandboxSecretMode({
        NODE_ENV: "production",
        SANDBOX_SECRET_MODE: "not-a-valid-mode",
      }),
    ).toBe("gateway_only");
  });

  test("gateway-only retains redaction values without exposing names, env, or files", async () => {
    const injection = buildInjection(decrypted, {
      excludeNames: PROVIDER_SECRET_NAMES,
      mode: "gateway_only",
    });

    expect(injection).toEqual({
      mode: "gateway_only",
      createEnv: {},
      files: [],
      names: [],
      redactionValues: ["custom-secret-value", "custom-file-value"],
    });

    let sandboxCommands = 0;
    expect(
      await materializeSecretInjection(async () => {
        sandboxCommands++;
        return { exitCode: 0 };
      }, injection),
    ).toEqual({ changed: false });
    expect(sandboxCommands).toBe(0);
    expect(sandboxSecretSourceCommand(injection.mode)).toBe(":");
  });

  test("compatibility mode preserves dotenv, file, marker names, and materialization", async () => {
    const injection = buildInjection(decrypted, {
      excludeNames: PROVIDER_SECRET_NAMES,
      mode: "compatibility",
    });

    expect(injection.mode).toBe("compatibility");
    expect(sandboxSecretSourceCommand(injection.mode)).toContain(`${SANDBOX_NAME_PREFIX}-env.sh`);
    expect(injection.createEnv).toEqual({ BASH_ENV: SECRET_DOTENV_PATH });
    expect(injection.names).toEqual(["CUSTOM_TOKEN", "CUSTOM_CERT"]);
    expect(injection.redactionValues).toEqual(["custom-secret-value", "custom-file-value"]);
    const pathQuote = SECRET_FILE_DIR.startsWith("$HOME/") ? '"' : "'";
    expect(injection.files).toEqual([
      {
        path: SECRET_DOTENV_PATH,
        content:
          `export CUSTOM_TOKEN='custom-secret-value'\n` +
          `export CUSTOM_CERT=${pathQuote}${SECRET_FILE_DIR}/CUSTOM_CERT${pathQuote}\n`,
      },
      { path: `${SECRET_FILE_DIR}/CUSTOM_CERT`, content: "custom-file-value" },
    ]);

    const commands: string[] = [];
    const result = await materializeSecretInjection(async (command) => {
      commands.push(command);
      return { exitCode: 0, result: "changed" };
    }, injection);
    expect(result).toEqual({ changed: true });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(`${SANDBOX_NAME_PREFIX}-env.sh`);
    expect(commands[0]).not.toContain("custom-secret-value");
    expect(commands[0]).not.toContain("custom-file-value");
  });
});
