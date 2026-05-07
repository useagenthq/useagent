/**
 * Socket Mode safety guard — startSlackSocketMode() must be a HARD no-op under
 * the test runner. Without the guard, a test-booted server that inherits the
 * real SLACK_APP_TOKEN from backend/.env would call apps.connections.open and
 * open a live WebSocket to the workspace, stealing real events mid-suite (Slack
 * load-balances an app's events across every open Socket Mode connection).
 *
 * We stub global.fetch and assert connections.open is never attempted while
 * NODE_ENV=test — then a positive control flips NODE_ENV to prove the guard, not
 * a missing token, is what suppresses the connection.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startSlackSocketMode, stopSlackSocketMode } from "../src/slack/socket-mode";

const CONNECTIONS_OPEN = "https://slack.com/api/apps.connections.open";

let realFetch: typeof fetch;
let fetchUrls: string[];
let realNodeEnv: string | undefined;
let realAppToken: string | undefined;

beforeEach(() => {
  realFetch = globalThis.fetch;
  realNodeEnv = process.env.NODE_ENV;
  realAppToken = process.env.SLACK_APP_TOKEN;
  fetchUrls = [];
  // Fake token so the test never depends on backend/.env being present.
  process.env.SLACK_APP_TOKEN = "xapp-fake-test-token";
  // A stub that records the URL and reports connections.open as failed, so even
  // when the guard is off (positive control) no real WebSocket is ever opened.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchUrls.push(String(input));
    return new Response(JSON.stringify({ ok: false, error: "stubbed" }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  stopSlackSocketMode();
  globalThis.fetch = realFetch;
  if (realNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = realNodeEnv;
  if (realAppToken === undefined) delete process.env.SLACK_APP_TOKEN;
  else process.env.SLACK_APP_TOKEN = realAppToken;
});

describe("slack socket mode test guard", () => {
  test("is a hard no-op under NODE_ENV=test even with an app token set", async () => {
    expect(process.env.NODE_ENV).toBe("test"); // bun test sets this
    startSlackSocketMode();
    // Give any (unwanted) async connect() a beat to reach fetch.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchUrls).toHaveLength(0); // connections.open never attempted
  });

  test("positive control: without the test guard it DOES attempt connections.open", async () => {
    process.env.NODE_ENV = "development";
    startSlackSocketMode();
    await new Promise((r) => setTimeout(r, 20));
    stopSlackSocketMode(); // set stopped=true so the backoff reconnect stays dead
    expect(fetchUrls).toContain(CONNECTIONS_OPEN);
  });
});
