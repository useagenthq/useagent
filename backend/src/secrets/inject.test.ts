import { describe, expect, test } from "bun:test";
import type { DecryptedSecrets } from "./store";
import {
  buildInjection,
  materializeSecretInjection,
  PROVIDER_SECRET_NAMES,
  sandboxSecretMode,
  sandboxSecretSourceCommand,
  SECRET_DOTENV_PATH,
  SECRET_FILE_DIR,
} from "./inject";

const decrypted: DecryptedSecrets = {
  secrets: [
    { name: "CUSTOM_TOKEN", kind: "env", value: "custom-secret-value" },
    { name: "CUSTOM_CERT", kind: "file", value: "custom-file-value" },
    { name: "OPENAI_API_KEY", kind: "env", value: "provider-secret-value" },
  ],
  names: ["CUSTOM_TOKEN", "CUSTOM_CERT", "OPENAI_API_KEY"],
  skipped: [],
};

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
    expect(sandboxSecretSourceCommand(injection.mode)).toContain("skynet-env.sh");
    expect(injection.createEnv).toEqual({ BASH_ENV: SECRET_DOTENV_PATH });
    expect(injection.names).toEqual(["CUSTOM_TOKEN", "CUSTOM_CERT"]);
    expect(injection.redactionValues).toEqual(["custom-secret-value", "custom-file-value"]);
    expect(injection.files).toEqual([
      {
        path: SECRET_DOTENV_PATH,
        content:
          `export CUSTOM_TOKEN='custom-secret-value'\n` +
          `export CUSTOM_CERT="${SECRET_FILE_DIR}/CUSTOM_CERT"\n`,
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
    expect(commands[0]).toContain("skynet-env.sh");
    expect(commands[0]).not.toContain("custom-secret-value");
    expect(commands[0]).not.toContain("custom-file-value");
  });
});
