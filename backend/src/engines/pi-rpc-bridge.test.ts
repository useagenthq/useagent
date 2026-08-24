import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import { DefaultPiBridgeManager } from "./pi-rpc-bridge";

function sandboxWithBracketedPastePrefix(): SandboxHandle {
  const encoder = new TextEncoder();
  return {
    id: "cube-box",
    cpu: 2,
    memory: 4,
    state: "started",
    process: {
      async createPty({ onData }) {
        return {
          async waitForConnection() {},
          async sendInput(input) {
            const text = typeof input === "string" ? input : new TextDecoder().decode(input);
            if (text.startsWith("stty ")) {
              await onData(encoder.encode("\u001b[?2004hroot@box:/work# "));
              await onData(encoder.encode(text.trimEnd()));
              await onData(encoder.encode("\r\n\u001b[?2004l\r"));
              await onData(encoder.encode(
                '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}\n',
              ));
              return;
            }
            const request = JSON.parse(text) as { id: string; type: string };
            const data = request.type === "get_state"
              ? { sessionId: "pi-session", sessionFile: "/home/useagent-pi/agent/sessions/pi.jsonl" }
              : { level: "events" };
            await onData(encoder.encode(JSON.stringify({
              type: "response",
              id: request.id,
              command: request.type,
              success: true,
              data,
            }) + "\n"));
          },
          async resize() {},
          async disconnect() {},
          async kill() {},
        };
      },
    } as SandboxHandle["process"],
    fs: {} as SandboxHandle["fs"],
    async start() {},
    async delete() {},
    async getPreviewLink() {
      return { url: "https://example.test" };
    },
  };
}

describe("Pi RPC frame parsing", () => {
  test("becomes ready when Cube prefixes the first RPC frame with terminal control bytes", async () => {
    const manager = new DefaultPiBridgeManager();
    const session = await manager.ensure({
      sandbox: sandboxWithBracketedPastePrefix(),
      workdir: "/work",
      runtime: {
        model: { provider: "openai", modelId: "gpt-5.6-luna", selector: "openai/gpt-5.6-luna" },
        fingerprint: "runtime",
        knowledgeTools: false,
        executable: "/opt/useagent/pi-runtime/cli.js",
        bunExecutable: "/opt/useagent/pi-runtime/bun",
        runAsUser: "useagent-pi",
        home: "/home/useagent-pi",
      },
    });

    expect(session.sessionId).toBe("pi-session");
    expect(session.sessionFile).toBe("/home/useagent-pi/agent/sessions/pi.jsonl");
    await session.dispose();
  }, 2_000);
});
