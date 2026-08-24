import { describe, expect, test } from "bun:test";
import { DEFAULT_BASE_URL, resolveConfig } from "../src/config";

describe("resolveConfig", () => {
  test("reads the api key and defaults the base url", () => {
    expect(resolveConfig({ USEAGENT_API_KEY: "uak_1" })).toEqual({
      apiKey: "uak_1",
      baseUrl: DEFAULT_BASE_URL,
    });
  });

  test("honors an explicit base url and trims whitespace", () => {
    expect(resolveConfig({ USEAGENT_API_KEY: "  uak_2 ", USEAGENT_BASE_URL: " https://x.dev " })).toEqual({
      apiKey: "uak_2",
      baseUrl: "https://x.dev",
    });
  });

  test("throws a terse error naming the missing key", () => {
    expect(() => resolveConfig({})).toThrow("USEAGENT_API_KEY is not set");
    expect(() => resolveConfig({ USEAGENT_API_KEY: "   " })).toThrow("USEAGENT_API_KEY is not set");
  });
});
