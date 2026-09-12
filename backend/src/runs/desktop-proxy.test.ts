import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { desktopClientQueryRedirect } from "./desktop-proxy";

describe("desktop proxy recovery", () => {
  test("reflects provider VNC client state without replacing the proxy path", () => {
    const source = new URL(
      "https://app.example/api/desktop-proxy/thread/vnc.html?autoconnect=1&path=api%2Fdesktop-proxy%2Fthread%2Fwebsockify",
    );
    const redirect = desktopClientQueryRedirect(source, {
      password: "provider-password",
    });
    expect(redirect).not.toBeNull();
    const parsed = new URL(redirect!);
    expect(parsed.searchParams.get("password")).toBe("provider-password");
    expect(parsed.searchParams.get("path")).toBe(
      "api/desktop-proxy/thread/websockify",
    );
    expect(
      desktopClientQueryRedirect(parsed, { password: "provider-password" }),
    ).toBeNull();
  });

  test("repairs retained Daytona desktops before retrying a failed preview", () => {
    const source = readFileSync(new URL("./desktop-proxy.ts", import.meta.url), "utf8");

    expect(source).toContain("await ensureDesktopPreview(threadId)");
    expect(source).toContain("await ensureSandboxDesktopView(sandbox, AbortSignal.timeout(120_000))");
    expect(source).toContain("const desktopRepairs = new Map<string, Promise<void>>()");
    expect(source).toContain('desktopProxyRoutes.get("/:threadId/ready"');
    expect(source).toContain("const desktopReadyUntil = new Map<string, number>()");
    expect(source).toContain("invalidateDesktopPreview(threadId)");
  });
});
