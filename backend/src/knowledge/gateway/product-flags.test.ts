import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  localProductFlags,
  parsePrimaryProductFlags,
  primaryApiOriginFor,
  productFlagsForToolList,
  resetProductFlagsForTest,
} from "./product-flags";

const BRIDGE = {
  GATEWAY_DATABASE_URL: "postgres://gateway@127.0.0.1/useagent",
  USEAGENT_API_ORIGIN: "http://127.0.0.1:3299",
  PRODUCT_CHILD_THREADS: "off",
  BOTS: "off",
} as const;

function primaryAnswering(product: unknown, status = 200) {
  const calls: string[] = [];
  const fetchImpl = async (input: string): Promise<Response> => {
    calls.push(input);
    return new Response(JSON.stringify({ product }), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

let errors: ReturnType<typeof spyOn>;
let warnings: ReturnType<typeof spyOn>;

beforeEach(() => {
  resetProductFlagsForTest();
  errors = spyOn(console, "error").mockImplementation(() => {});
  warnings = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errors.mockRestore();
  warnings.mockRestore();
});

describe("gateway product flags", () => {
  test("parses only a complete boolean product block", () => {
    expect(parsePrimaryProductFlags({ product: { childThreads: true, bots: false } })).toEqual({ childThreads: true, bots: false });
    expect(parsePrimaryProductFlags({ product: { childThreads: "on", bots: true } })).toBeNull();
    expect(parsePrimaryProductFlags({ engines: [] })).toBeNull();
    expect(parsePrimaryProductFlags(null)).toBeNull();
  });

  test("the primary origin exists only in bridge mode with a usable USEAGENT_API_ORIGIN", () => {
    expect(primaryApiOriginFor({})).toBeNull();
    expect(primaryApiOriginFor({ USEAGENT_API_ORIGIN: "http://127.0.0.1:3299" })).toBeNull();
    expect(primaryApiOriginFor(BRIDGE)).toBe("http://127.0.0.1:3299");
    expect(primaryApiOriginFor({ ...BRIDGE, USEAGENT_API_ORIGIN: "ftp://x" })).toBeNull();
  });

  test("outside bridge mode the process's own flags decide", async () => {
    const env = { PRODUCT_CHILD_THREADS: "on", BOTS: "off" };
    expect(localProductFlags(null, env)).toEqual({ childThreads: true, bots: false });
    const { fetchImpl, calls } = primaryAnswering({ childThreads: false, bots: true });
    expect(await productFlagsForToolList("org-a", { env, fetchImpl })).toEqual({ childThreads: true, bots: false });
    expect(calls).toEqual([]);
  });

  test("in bridge mode the primary's answer wins and a disagreement is logged at error level", async () => {
    const { fetchImpl, calls } = primaryAnswering({ childThreads: true, bots: true });
    const flags = await productFlagsForToolList("org-a", { env: BRIDGE, fetchImpl });
    expect(flags).toEqual({ childThreads: true, bots: true });
    expect(calls).toEqual(["http://127.0.0.1:3299/api/config"]);
    expect(errors).toHaveBeenCalledTimes(1);
    const message = String(errors.mock.calls[0]?.[0]);
    expect(message).toContain("PRODUCT_CHILD_THREADS here=off primary=on");
    expect(message).toContain("BOTS here=off primary=on");

    // Cached for a minute: no second fetch, no second log.
    await productFlagsForToolList("org-b", { env: BRIDGE, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  test("an unreachable primary falls back to the process's own flags with a warning", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("connect ECONNREFUSED");
    };
    const env = { ...BRIDGE, PRODUCT_CHILD_THREADS: "on", BOTS: "on" };
    expect(await productFlagsForToolList("org-a", { env, fetchImpl })).toEqual({ childThreads: true, bots: true });
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(String(warnings.mock.calls[0]?.[0])).toContain("could not read product flags from the primary");
    expect(errors).not.toHaveBeenCalled();
  });

  test("an older primary without the product block also falls back", async () => {
    const { fetchImpl } = primaryAnswering(undefined);
    expect(await productFlagsForToolList("org-a", { env: BRIDGE, fetchImpl })).toEqual({ childThreads: false, bots: false });
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  test("a canary org keeps its child threads even when the primary's global flag is off", async () => {
    const { fetchImpl } = primaryAnswering({ childThreads: false, bots: false });
    const env = { ...BRIDGE, PRODUCT_CHILD_CANARY_ORG_IDS: "org-canary" };
    expect(await productFlagsForToolList("org-canary", { env, fetchImpl })).toEqual({ childThreads: true, bots: false });
    expect(await productFlagsForToolList("org-other", { env, fetchImpl })).toEqual({ childThreads: false, bots: false });
  });
});
