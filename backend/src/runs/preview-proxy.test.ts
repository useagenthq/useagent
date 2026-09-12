import { describe, expect, test } from "bun:test";
import { buildForwardHeaders } from "./preview-proxy";

describe("preview proxy forward headers", () => {
  test("the endpoint's auth headers replace anything the browser sent; hop-by-hop and inbound credentials are dropped", () => {
    const inbound = new Headers({
      host: "app.example",
      connection: "keep-alive",
      cookie: "__Secure-better-auth.session_token=browser-session",
      "x-daytona-preview-token": "leaked",
      "cube-traffic-access-token": "leaked",
      accept: "text/event-stream",
    });
    const box = buildForwardHeaders(inbound, { cookie: "_port_auth=port-cookie" });
    expect(box.get("cookie")).toBe("_port_auth=port-cookie");
    expect(box.get("x-daytona-preview-token")).toBeNull();
    expect(box.get("cube-traffic-access-token")).toBeNull();
    expect(box.get("host")).toBeNull();
    expect(box.get("accept")).toBe("text/event-stream");

    const daytona = buildForwardHeaders(inbound, { "x-daytona-preview-token": "real" });
    expect(daytona.get("x-daytona-preview-token")).toBe("real");
    expect(daytona.get("cookie")).toBeNull();
  });
});
