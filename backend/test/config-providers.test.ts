import { afterEach, expect, test } from "bun:test";
import { deploymentProvidedProviders } from "../src/provider-gateway/provider";
import { json } from "./helpers";

const original = process.env.OPENAI_API_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = original;
});

test("deploymentProvidedProviders names each provider the server keys serve, never a value", () => {
  expect(deploymentProvidedProviders({})).toEqual({
    anthropic: false,
    openai: false,
    openrouter: false,
    cerebras: false,
  });
  expect(
    deploymentProvidedProviders({ OPENAI_API_KEY: "sk-live", ANTHROPIC_API_KEY: "   " }),
  ).toEqual({ anthropic: false, openai: true, openrouter: false, cerebras: false });
});

test("GET /api/config reports the deployment-provided providers and follows the env", async () => {
  process.env.OPENAI_API_KEY = "sk-test-deployment";
  const served = await json<{ providers: Record<string, boolean> }>("/api/config");
  expect(served.status).toBe(200);
  expect(served.body.providers.openai).toBe(true);
  expect(JSON.stringify(served.body)).not.toContain("sk-test-deployment");
  delete process.env.OPENAI_API_KEY;
  const unserved = await json<{ providers: Record<string, boolean> }>("/api/config");
  expect(unserved.body.providers.openai).toBe(false);
});
