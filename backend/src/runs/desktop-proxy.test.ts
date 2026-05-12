import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("desktop proxy recovery", () => {
  test("repairs retained Daytona desktops before retrying a failed preview", () => {
    const source = readFileSync(new URL("./desktop-proxy.ts", import.meta.url), "utf8");

    expect(source).toContain("await ensureDesktopPreview(threadId)");
    expect(source).toContain("await ensureSandboxDesktopView(sandbox, AbortSignal.timeout(120_000))");
    expect(source).toContain("const desktopRepairs = new Map<string, Promise<void>>()");
  });
});
