import { describe, expect, test } from "bun:test";
import { validateProviderDriver } from "@skynet/agent-harness/control";
import {
  makeOpenCodeProviderDriver,
  opencodeHarness,
  opencodeProviderDriver,
} from "../src/engines/opencode-server";
import type { HarnessSession } from "@skynet/agent-harness/canonical";
import type { HarnessSessionHandle } from "../src/engines/types";

// Contract test for the Stage-1 typed harness seam. The control ops resolve to
// classified, non-throwing results even with no reachable sandbox — the key
// invariant behind restart/cancel safety. (Reachable-sandbox behavior is proven
// live in the reconcile integration on :3503.)

const HANDLE: HarnessSessionHandle = {
  provider: "opencode",
  sessionId: "ses_x",
  sandboxId: "does-not-exist",
};

const RESIDENT = {
  baseUrl: "https://sandbox.example.test",
  token: "preview-token",
  dirQ: "?directory=%2Fhome%2Fdaytona%2Fwork",
};

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("opencode harness seam", () => {
  test("capabilities() reports opencode's native support", () => {
    const caps = opencodeHarness.capabilities();
    expect(opencodeHarness.provider).toBe("opencode");
    expect(caps.cancel).toBe(true);
    expect(caps.resume).toBe(true);
    expect(caps.streaming).toBe("parts");
    expect(caps.authoritativeHistory).toBe(true);
    expect(caps.childSessions).toBe(true);
    // A fresh object each call — callers can't mutate the shared capability map.
    expect(opencodeHarness.capabilities()).not.toBe(caps);
  });

  test("cancel + reconcile return typed results (never throw) when unreachable", async () => {
    const saved = process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_KEY;
    try {
      const t0 = Date.now();
      const cancelled = await opencodeHarness.cancel(HANDLE, "user requested stop");
      expect(cancelled.status).toBe("error");
      if (cancelled.status === "error") expect(cancelled.code).toBe("sandbox_unreachable");

      const rec = await opencodeHarness.reconcile(HANDLE, { sinceMs: 0 });
      expect(rec.status).toBe("unreachable");

      // Both are bounded — an unreachable sandbox never hangs a control op.
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally {
      if (saved !== undefined) process.env.DAYTONA_API_KEY = saved;
    }
  });
});

describe("opencode provider driver lifecycle seam", () => {
  test("descriptor validates against the ProviderDriver lifecycle contract", () => {
    expect(validateProviderDriver(opencodeProviderDriver)).toEqual({ status: "ok" });
    expect(opencodeProviderDriver.provider).toBe("opencode");
    expect(opencodeProviderDriver.descriptor.provider).toBe("opencode");
    expect(opencodeProviderDriver.descriptor.capabilities.stop).toBe(true);
    expect(opencodeProviderDriver.descriptor.capabilities.reconcile).toBe(true);
    expect(opencodeProviderDriver.descriptor.model).toMatchObject({
      selection: "per_turn",
      supportsArbitraryModel: true,
    });
    expect(opencodeProviderDriver.descriptor.tools).toMatchObject({
      mode: "skynet_brokered",
      approval: "skynet",
    });
  });

  test("routes OpenCode model families through the resident HTTP lifecycle", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const driver = makeOpenCodeProviderDriver({
      resolveResidentServer: async (sandboxId) => sandboxId === "sbx_1" ? RESIDENT : null,
      fetcher: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === `${RESIDENT.baseUrl}/session${RESIDENT.dirQ}`) {
          return json({ id: "ses_new" });
        }
        if (url === `${RESIDENT.baseUrl}/session/ses_new${RESIDENT.dirQ}`) {
          return json({ id: "ses_new" });
        }
        if (url === `${RESIDENT.baseUrl}/session/ses_new/message${RESIDENT.dirQ}`) {
          return json({ id: "msg_assistant" });
        }
        return json({ error: "unexpected" }, { status: 404 });
      },
    });

    const started = await driver.start({
      runId: "run_x",
      threadId: "thread_x",
      runtime: { kind: "sandbox", id: "sbx_1" },
    });
    expect(started.status).toBe("ok");
    if (started.status !== "ok") throw new Error("expected start to succeed");
    expect(started.value).toMatchObject({
      provider: "opencode",
      nativeSessionId: "ses_new",
      runtime: { kind: "sandbox", id: "sbx_1" },
      protocolVersion: "opencode-server",
      generation: 1,
    });

    await expect(
      driver.resume({
        session: started.value,
      }),
    ).resolves.toEqual({ status: "ok", value: started.value });

    await expect(
      driver.steer({
        runId: "run_x",
        threadId: "thread_x",
        session: started.value,
        input: { kind: "prompt", text: "continue", model: "openai/gpt-5.6-sol" },
      }),
    ).resolves.toEqual({ status: "ok" });

    await expect(
      driver.steer({
        runId: "run_x",
        threadId: "thread_x",
        session: started.value,
        input: { kind: "prompt", text: "use openrouter", model: "moonshotai/kimi-k3" },
      }),
    ).resolves.toEqual({ status: "ok" });

    await expect(
      driver.steer({
        runId: "run_x",
        threadId: "thread_x",
        session: started.value,
        input: { kind: "prompt", text: "use anthropic", model: "claude-opus-5" },
      }),
    ).resolves.toEqual({ status: "ok" });

    expect(calls.map((call) => [call.url, call.init?.method ?? "GET"])).toEqual([
      [`${RESIDENT.baseUrl}/session${RESIDENT.dirQ}`, "POST"],
      [`${RESIDENT.baseUrl}/session/ses_new${RESIDENT.dirQ}`, "GET"],
      [`${RESIDENT.baseUrl}/session/ses_new/message${RESIDENT.dirQ}`, "POST"],
      [`${RESIDENT.baseUrl}/session/ses_new/message${RESIDENT.dirQ}`, "POST"],
      [`${RESIDENT.baseUrl}/session/ses_new/message${RESIDENT.dirQ}`, "POST"],
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({});
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      model: { providerID: "openai", modelID: "gpt-5.6-sol" },
      parts: [{ type: "text", text: "continue" }],
    });
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({
      model: { providerID: "openrouter", modelID: "moonshotai/kimi-k3" },
      parts: [{ type: "text", text: "use openrouter" }],
    });
    expect(JSON.parse(String(calls[4]?.init?.body))).toEqual({
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      parts: [{ type: "text", text: "use anthropic" }],
    });
  });

  test("missing sandbox runtime is a classified dependency error, not a hidden global", async () => {
    const driver = makeOpenCodeProviderDriver();

    await expect(
      driver.start({
        runId: "run_x",
        threadId: "thread_x",
        runtime: { kind: "managed", id: "managed_1" },
      }),
    ).resolves.toEqual({
      status: "error",
      code: "invalid_runtime",
      message: "OpenCode provider start requires an existing sandbox runtime",
    });
  });

  test("unsupported non-prompt steer operations are explicit typed results", async () => {
    const session: HarnessSession = {
      provider: "opencode",
      nativeSessionId: "ses_x",
      runtime: { kind: "sandbox", id: "sbx_1" },
      protocolVersion: "opencode-server",
      capabilities: opencodeProviderDriver.descriptor.capabilities,
      generation: 1,
    };
    const driver = makeOpenCodeProviderDriver({
      resolveResidentServer: async () => RESIDENT,
      fetcher: async () => json({}),
    });

    await expect(
      driver.steer({
        runId: "run_x",
        threadId: "thread_x",
        session,
        input: { kind: "command", name: "compact" },
      }),
    ).resolves.toMatchObject({
      status: "unsupported_capability",
      provider: "opencode",
      capability: "steer",
    });
  });

  test("cancel is owned by the ProviderDriver and preserves the compatibility classification", async () => {
    const saved = process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_KEY;
    try {
      const session: HarnessSession = {
        provider: "opencode",
        nativeSessionId: HANDLE.sessionId,
        runtime: { kind: "sandbox", id: HANDLE.sandboxId },
        protocolVersion: "opencode-server",
        capabilities: opencodeProviderDriver.descriptor.capabilities,
        generation: 1,
      };
      await expect(opencodeProviderDriver.cancel(session, "user requested stop")).resolves.toEqual({
        status: "error",
        code: "sandbox_unreachable",
        message: "resident opencode server not reachable",
      });
    } finally {
      if (saved !== undefined) process.env.DAYTONA_API_KEY = saved;
    }
  });
});
