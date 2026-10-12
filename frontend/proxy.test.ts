import { describe, expect, test } from "bun:test";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";

import { config, proxy } from "./proxy";

describe("authentication proxy", () => {
  test("keeps the exact download page public while applying its script policy", () => {
    expect(
      unstable_doesMiddlewareMatch({
        config,
        url: "https://useagent.example.com/download",
      }),
    ).toBe(true);
    expect(proxy(new NextRequest("https://useagent.example.com/download")).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(new NextRequest("https://useagent.example.com/download-private")).status).toBe(307);
    expect(
      unstable_doesMiddlewareMatch({
        config,
        url: "https://useagent.example.com/download-private",
      }),
    ).toBe(true);
  });

  test("uses fresh server nonces for HTML without changing prefetch or RSC caching", () => {
    const request = () => new NextRequest("https://useagent.example.com/login", {
      headers: { "x-nonce": "attacker", "content-security-policy": "script-src 'unsafe-inline'" },
    });
    const first = proxy(request());
    const second = proxy(request());
    const policy = first.headers.get("content-security-policy");
    const nonce = policy?.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(policy).toContain("'strict-dynamic' 'wasm-unsafe-eval'");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    expect(second.headers.get("content-security-policy")).not.toBe(policy);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    for (const header of [{ rsc: "1" }, { "next-router-prefetch": "1" }, { purpose: "prefetch" }]) {
      const response = proxy(new NextRequest("https://useagent.example.com/login", {
        headers: { ...header, "x-nonce": "attacker", "content-security-policy": "script-src 'unsafe-inline'" },
      }));
      expect(response.headers.get("content-security-policy")).toBeNull();
      expect(response.headers.get("cache-control")).toBeNull();
      expect(response.headers.get("x-middleware-request-x-nonce")).toBeNull();
      expect(proxy(new NextRequest("https://useagent.example.com/settings", { headers: header })).status).toBe(307);
    }
    for (const path of ["/api/runs", "/_next/static/chunks/app.js", "/_next/image?url=icon.png"]) {
      expect(unstable_doesMiddlewareMatch({ config, url: `https://useagent.example.com${path}` })).toBe(false);
    }
  });

  test("opens only the development preview escape hatch", () => {
    const previousMode = process.env.NODE_ENV;
    const previousPreview = process.env.USEAGENT_PREVIEW_OPEN;
    process.env.USEAGENT_PREVIEW_OPEN = "1";
    try {
      process.env.NODE_ENV = "development";
      expect(
        proxy(new NextRequest("https://useagent.example.com/agent/new")).headers.get(
          "x-middleware-next",
        ),
      ).toBe("1");

      process.env.NODE_ENV = "production";
      expect(proxy(new NextRequest("https://useagent.example.com/agent/new")).status).toBe(307);
    } finally {
      if (previousMode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousMode;
      if (previousPreview === undefined) delete process.env.USEAGENT_PREVIEW_OPEN;
      else process.env.USEAGENT_PREVIEW_OPEN = previousPreview;
    }
  });

  test.each(["/login", "/signup"])("keeps %s public", (path) => {
    expect(
      proxy(new NextRequest(`https://useagent.example.com${path}`)).headers.get(
        "x-middleware-next",
      ),
    ).toBe("1");
  });

  test.each(["__Secure-better-auth.session_token", "better-auth.session_token"])(
    "accepts the Better Auth session cookie %s",
    (name) => {
      const request = new NextRequest("https://useagent.example.com/agent/new", {
        headers: { cookie: `${name}=opaque-session-token` },
      });
      expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
    },
  );

  test("redirects anonymous navigation to login", () => {
    const response = proxy(new NextRequest("https://useagent.example.com/agent/new"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://useagent.example.com/login");
  });

  test("sends an anonymous invitation link through sign-in and back", () => {
    const response = proxy(new NextRequest("https://useagent.example.com/accept-invitation/inv1"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://useagent.example.com/login?redirect_url=%2Faccept-invitation%2Finv1",
    );
  });

  test("keeps pages on their canonical no-slash path", () => {
    const response = proxy(
      new NextRequest("https://useagent.example.com/agent/new/?skill=fix", {
        headers: { cookie: "better-auth.session_token=opaque" },
      }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://useagent.example.com/agent/new?skill=fix",
    );
  });

  test("allows health, icons, and og images but protects similarly named routes", () => {
    for (const path of [
      "/healthz",
      "/icon.svg?v=current",
      "/opengraph-image",
      "/opengraph-image?v=current",
      "/twitter-image",
      // per-route OG images (issue #124) — must be public so link previews work
      "/bots/opengraph-image",
      "/settings/opengraph-image",
      "/bots/twitter-image",
      // static PNG files in public/og/ — direct image URLs used by og:image meta tags
      "/og/01-home.png",
      "/og/05-agents.png",
    ]) {
      expect(
        proxy(new NextRequest(`https://useagent.example.com${path}`)).headers.get(
          "x-middleware-next",
        ),
      ).toBe("1");
    }
    for (const path of [
      "/icon.svg-private",
      "/icon.svg/private",
      "/opengraph-image-private",
      "/twitter-image-private",
    ]) {
      expect(proxy(new NextRequest(`https://useagent.example.com${path}`)).status).toBe(307);
    }
  });
});
