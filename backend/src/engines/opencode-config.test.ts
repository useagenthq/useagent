import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { EngineRunContext } from "./types";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  buildOpencodeConfigWriteCommand,
  prepareOpencodeSandboxConfig,
} from "./opencode-server";
import { verifyToolToken } from "../knowledge/gateway/token";

const original = { ...process.env };

afterEach(() => {
  for (const name of [
    "GATEWAY_PUBLIC_URL",
    "PROVIDER_GATEWAY_SECRET",
    "TOOL_GATEWAY_SECRET",
    "TOOL_GATEWAY_TOKEN_TTL_MS",
  ]) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function runContext(): EngineRunContext {
  return {
    runId: "run-opencode-config",
    prompt: "x",
    bootstrapContext: "",
    turnContext: "",
    workdir: "/work",
    threadId: "thread-opencode-config",
    orgId: "org-a",
    userId: "user-a",
    model: "claude-opus-5",
    signal: new AbortController().signal,
    emit: async () => undefined,
    setSummary: () => {},
  };
}

describe("OpenCode generated config placement", () => {
  test("writes capabilities to the global config and removes the project copy", () => {
    const command = buildOpencodeConfigWriteCommand("e30=");

    expect(command).toContain("> ~/.config/opencode/opencode.json");
    expect(command).toContain("chmod 600 ~/.config/opencode/opencode.json");
    expect(command).toContain("rm -f -- ~/work/opencode.json");
    expect(command).not.toContain("tee");
  });

  test("rejects shell input that is not base64", () => {
    expect(() => buildOpencodeConfigWriteCommand("$(touch /tmp/nope)")).toThrow(
      "opencode config must be base64 encoded",
    );
  });

  test("keeps the memoized knowledge token within the configured TTL", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_TOKEN_TTL_MS = "60000";
    const before = Date.now();

    const prepared = await prepareOpencodeSandboxConfig(
      {} as SandboxHandle,
      runContext(),
      {},
    );
    const after = Date.now();
    const mcp = prepared?.config.mcp as Record<
      string,
      { headers: { Authorization: string } }
    >;
    const token = mcp["skynet-knowledge"]!.headers.Authorization.replace(/^Bearer /, "");
    const claims = verifyToolToken(token, before);

    expect(claims).not.toBeNull();
    expect(claims!.exp).toBeGreaterThanOrEqual(before + 60_000);
    expect(claims!.exp).toBeLessThanOrEqual(after + 60_000);
  });

  test("activates warm config in-process with a verified restart fallback", () => {
    const source = readFileSync(new URL("./opencode-server.ts", import.meta.url), "utf8");

    expect(source).toContain("activateOpenCodeRuntimeConfig({");
    expect(source).toContain("reuseHealthyResidentServer(rememberedServer, box.id, ctx.signal)");
    // Perf Phase 1: the same concurrent stages now flow through stagesTogether,
    // which honors the SKYNET_SERIAL_STARTUP rollback flag (same DAG, concurrency 1).
    expect(source).toContain(
      "const [desktop, cachedRuntimeServer, , baseOpenCodeConfig] = await stagesTogether([",
    );
    expect(source).toContain(
      'prepareStage("base_config", () => readOpencodeSandboxConfig(box))',
    );
    expect(source).toContain("await stagesTogether([activateRuntime, prepareRepositories])");
    expect(source).toContain("await stopServerForConfigReload(box, runtimeServer, ctx.signal)");
    expect(source).toContain("await verifyOpenCodeRuntimeConfig({");
    expect(source).not.toContain(
      "await sandbox.process.deleteSession(SERVER_PROCESS_SESSION).catch(() => {});\n      }",
    );
  });
});
