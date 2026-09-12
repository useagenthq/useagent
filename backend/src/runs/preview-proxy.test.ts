import { describe, expect, test } from "bun:test";
import { buildForwardHeaders, buildProxyResponse } from "./preview-proxy";

describe("preview proxy forward headers", () => {
  test("the endpoint's auth headers replace anything the browser sent; hop-by-hop and inbound credentials are dropped", () => {
    const inbound = new Headers({
      host: "app.example",
      connection: "keep-alive",
      cookie: "__Secure-better-auth.session_token=browser-session",
      authorization: "Bearer product-api-key",
      "proxy-authorization": "Basic product-proxy-credential",
      forwarded: "for=192.0.2.1;host=app.example;proto=https",
      "x-forwarded": "for=192.0.2.1",
      "x-forwarded-for": "192.0.2.1",
      "x-forwarded-host": "app.example",
      "x-forwarded-proto": "https",
      "x-forwarded-custom-auth": "product-credential",
      "x-real-ip": "192.0.2.1",
      "x-daytona-preview-token": "leaked",
      "cube-traffic-access-token": "leaked",
      accept: "text/event-stream",
      "x-preview-app": "preserved",
    });
    const box = buildForwardHeaders(inbound, { cookie: "_port_auth=port-cookie" });
    expect(box.get("cookie")).toBe("_port_auth=port-cookie");
    expect(box.get("x-daytona-preview-token")).toBeNull();
    expect(box.get("cube-traffic-access-token")).toBeNull();
    expect(box.get("host")).toBeNull();
    for (const name of ["authorization", "proxy-authorization", "forwarded", "x-forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-custom-auth", "x-real-ip"]) {
      expect(box.get(name)).toBeNull();
    }
    expect(box.get("accept")).toBe("text/event-stream");
    expect(box.get("x-preview-app")).toBe("preserved");

    const daytona = buildForwardHeaders(inbound, { "x-daytona-preview-token": "real" });
    expect(daytona.get("x-daytona-preview-token")).toBe("real");
    expect(daytona.get("cookie")).toBeNull();
    expect(buildForwardHeaders(inbound, { authorization: "Bearer provider-only" }).get("authorization")).toBe("Bearer provider-only");
  });

  test("a sandbox response cannot set product cookies, clear product storage, or widen service-worker scope", async () => {
    const response = buildProxyResponse(new Response("data: preview\n\n", {
      headers: {
        "content-type": "text/event-stream",
        "set-cookie": "product-session=attacker; Path=/; Secure",
        "set-cookie2": "product-session=attacker; Path=/; Secure",
        "clear-site-data": '"cookies", "storage"',
        "service-worker-allowed": "/",
        "x-preview-app": "preserved",
      },
    }));
    for (const name of ["set-cookie", "set-cookie2", "clear-site-data", "service-worker-allowed"]) {
      expect(response.headers.get(name)).toBeNull();
    }
    expect(response.headers.get("x-preview-app")).toBe("preserved");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(await response.text()).toBe("data: preview\n\n");
  });
});
