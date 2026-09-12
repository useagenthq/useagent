import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makePiAdapter } from "./pi-adapter";

const priorGatewayUrl = process.env.PROVIDER_GATEWAY_PUBLIC_URL;
const priorGatewaySecret = process.env.PROVIDER_GATEWAY_SECRET;

beforeAll(() => {
  process.env.PROVIDER_GATEWAY_PUBLIC_URL = "https://gateway.example.test";
  process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (priorGatewayUrl === undefined) delete process.env.PROVIDER_GATEWAY_PUBLIC_URL;
  else process.env.PROVIDER_GATEWAY_PUBLIC_URL = priorGatewayUrl;
  if (priorGatewaySecret === undefined) delete process.env.PROVIDER_GATEWAY_SECRET;
  else process.env.PROVIDER_GATEWAY_SECRET = priorGatewaySecret;
});

describe("Pi adapter", () => {
  test("fences pending native teardown before sandbox preparation", async () => {
    const calls: string[] = [];
    const adapter = makePiAdapter({
      bridges: {
        ensure: async () => { throw new Error("not reached"); },
        get: () => undefined,
        awaitTeardown: async (sessionFile) => {
          calls.push(`teardown:${sessionFile}`);
          throw new Error("remote teardown is still pending");
        },
        remove: async () => {},
      },
      prepareTurn: (async () => {
        calls.push("prepare");
        throw new Error("preparation must not start");
      }) as never,
    });

    await expect(adapter.run({
      providerSession: {
        provider: "pi",
        nativeSessionId: "/sessions/pi.jsonl",
      },
    } as never)).rejects.toThrow("remote teardown is still pending");
    expect(calls).toEqual(["teardown:/sessions/pi.jsonl"]);
  });
});
