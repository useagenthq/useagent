import { describe, expect, test } from "bun:test";
import server from "../src/index";
import { BASE, ORIGIN } from "./helpers";
import { isPublicApiPath } from "../src/middleware/org";

// The universal auth adapter (index.ts) org-scopes every /api/* path EXCEPT the
// prefixes isPublicApiPath() allows. The security property under test is
// fail-CLOSED by default: a path the adapter does not recognize is treated as
// protected (routed through orgScope), so a future router that forgets its own
// `.use(orgScope)` guard is still not public.

describe("isPublicApiPath — the allowlist is the ONLY escape from org scoping", () => {
  test("public + self-authenticating prefixes are allowed through", () => {
    // Public, secret-free:
    expect(isPublicApiPath("/api/health")).toBe(true);
    expect(isPublicApiPath("/api/config")).toBe(true);
    // Self-authenticating (own boundary, not org-session):
    expect(isPublicApiPath("/api/auth/sign-in")).toBe(true);
    expect(isPublicApiPath("/api/auth/session")).toBe(true);
    expect(isPublicApiPath("/api/slack/events")).toBe(true); // signature verified
  });

  test("every domain route is protected (not on the allowlist)", () => {
    for (const p of [
      "/api/runs",
      "/api/runs/abc/thread-events",
      "/api/secrets",
      "/api/memory",
      "/api/knowledge",
      "/api/skills",
      "/api/schedules",
      "/api/fleet",
      "/api/repos",
      "/api/pulls",
      "/api/wiki/generate",
      "/api/commands",
      "/api/mcp/knowledge",
      "/api/provider/openai/v1/responses",
    ]) {
      expect(isPublicApiPath(p)).toBe(false);
    }
  });

  test("fail-closed default: an unknown/future path is NOT public", () => {
    expect(isPublicApiPath("/api/some-future-router")).toBe(false);
    expect(isPublicApiPath("/api/admin/danger")).toBe(false);
    // Near-misses must not slip through prefix matching:
    expect(isPublicApiPath("/api/configuration")).toBe(false); // not exactly /api/config
    expect(isPublicApiPath("/api/authorize")).toBe(false); // not the /api/auth/ prefix
    expect(isPublicApiPath("/api/mcpx")).toBe(false); // not the /api/mcp/ prefix
  });
});

describe("adapter end-to-end through the real app", () => {
  test("a public path is reachable with no session", async () => {
    const res = await server.fetch(
      new Request(BASE + "/api/config", { headers: { origin: ORIGIN } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      capabilities?: unknown;
      models?: Record<string, unknown>;
    };
    expect(body.capabilities).toBeDefined();
    expect(body.models).toBeDefined();
    // Engine/model advertisement is governed by independently tested release
    // evidence. This adapter test proves only that the public config boundary
    // remains reachable without weakening the protected-path default.
    expect(body.models).toBeObject();
  });

  test("a protected path is org-scoped by the adapter (identity resolved, not bypassed)", async () => {
    // In the test env dev-org is allowed, so an anonymous protected request
    // resolves to the dev org (200) rather than 401 - proving the adapter ran
    // orgScope and set an identity. The 401 leg is orgScope's own contract when
    // ALLOW_DEV_ORG=0 (the production switch), covered by the org middleware.
    const res = await server.fetch(
      new Request(BASE + "/api/secrets", { headers: { origin: ORIGIN } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secrets?: unknown[] };
    expect(Array.isArray(body.secrets)).toBe(true);
  });
});
