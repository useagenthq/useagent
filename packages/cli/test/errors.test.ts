import { describe, expect, test } from "bun:test";
import { AgentClientError } from "@useagent/agent-client/api";
import { apiKeyFailure, apiKeysUrl, CliError, toCliError } from "../src/errors";

describe("apiKeysUrl", () => {
  test("points at the API keys section of Settings, with or without a trailing slash", () => {
    expect(apiKeysUrl("https://app.example.com")).toBe("https://app.example.com/settings#apikeys");
    expect(apiKeysUrl("https://app.example.com//")).toBe("https://app.example.com/settings#apikeys");
  });
});

describe("apiKeyFailure", () => {
  test("a 401 names the server and where to make a new key", () => {
    const failure = apiKeyFailure(401, "https://app.example.com");
    expect(failure?.message).toBe(
      "https://app.example.com did not accept USEAGENT_API_KEY (HTTP 401). If it was revoked, mistyped or made on another server, create a key in Settings, API keys (https://app.example.com/settings#apikeys) and export it as USEAGENT_API_KEY",
    );
    expect(failure?.exitCode).toBe(1);
  });

  test("a 403 is refused access and never calls the key invalid", () => {
    const failure = apiKeyFailure(403, "https://app.example.com");
    expect(failure?.message).toContain("accepted USEAGENT_API_KEY but refused the request (HTTP 403)");
    expect(failure?.message).not.toContain("did not accept");
    expect(failure?.exitCode).toBe(1);
  });

  test("any other status, or none, is not about the key", () => {
    for (const status of [undefined, 400, 404, 429, 500]) {
      expect(apiKeyFailure(status, "https://app.example.com")).toBeNull();
    }
  });
});

describe("toCliError", () => {
  test("passes a CliError through with its exit code", () => {
    const usage = new CliError("unknown flag: --nope", 2);
    expect(toCliError(usage, "https://app.example.com")).toBe(usage);
  });

  test("explains a refused key from the client", () => {
    const failure = toCliError(
      new AgentClientError("http_error", "POST /api/runs -> HTTP 401", 401),
      "https://app.example.com",
    );
    expect(failure.message).toContain("Settings, API keys (https://app.example.com/settings#apikeys)");
    expect(failure.exitCode).toBe(1);
  });

  test("keeps any other failure's message and exits 1", () => {
    const server = toCliError(new AgentClientError("http_error", "GET /x -> HTTP 500", 500), "https://app.example.com");
    expect([server.message, server.exitCode]).toEqual(["GET /x -> HTTP 500", 1]);
    expect(toCliError("boom", "https://app.example.com").message).toBe("boom");
  });
});
