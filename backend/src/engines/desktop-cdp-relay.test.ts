import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  desktopCdpRelaySource,
  desktopCdpRelayToken,
  ensureDesktopCdpRelayFiles,
  resetDesktopCdpRelayTokensForTest,
} from "./desktop-cdp-relay";

describe("authenticated desktop CDP relay", () => {
  test("limits the provider-facing surface and keeps raw CDP on loopback", () => {
    const source = desktopCdpRelaySource();

    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(source)).not.toThrow();
    expect(source).toContain('hostname: "0.0.0.0"');
    expect(source).toContain('url.hostname = "127.0.0.1"');
    expect(source).toContain('path.startsWith("/devtools/page/")');
    expect(source).toContain('["/json/list", "/json/version"]');
    expect(source).toContain("timingSafeEqual");
    expect(source).not.toContain("/json/new");
  });

  test("stores a private per-sandbox token outside process arguments", async () => {
    resetDesktopCdpRelayTokensForTest();
    const files = new Map<string, Buffer>();
    const commands: string[] = [];
    const sandbox = {
      id: "relay-sandbox",
      fs: {
        downloadFile: async (path: string) => {
          const file = files.get(path);
          if (!file) throw new Error("missing file");
          return file;
        },
        uploadFile: async (file: Buffer, path: string) => files.set(path, file),
      },
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;

    const token = await ensureDesktopCdpRelayFiles(sandbox, "/home/daytona");

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(files.get("/home/daytona/.skynet/cdp-relay.token")?.toString()).toBe(`${token}\n`);
    expect(commands.join("\n")).not.toContain(token);
    await expect(desktopCdpRelayToken(sandbox)).resolves.toBe(token);
  });
});
