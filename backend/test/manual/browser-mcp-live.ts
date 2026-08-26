/**
 * Manual Daytona proof for the shared visible browser MCP transport.
 *
 * Required:
 *   SANDBOX_ID=<daytona-id> bun --env-file=../.env --env-file=.env \
 *     run test/manual/browser-mcp-live.ts
 *
 * Optional:
 *   MCP_SNAPSHOT_MODE=none|full (default: full)
 *   MCP_TOOL=browser_snapshot
 *   MCP_ARGS_JSON='{}'
 *   MCP_TIMEOUT_MS=30000
 */
import { Daytona } from "@daytona/sdk";

const sandboxId = process.env.SANDBOX_ID;
if (!sandboxId) throw new Error("SANDBOX_ID is required");

const snapshotMode = process.env.MCP_SNAPSHOT_MODE === "none" ? "none" : "full";
const toolName = process.env.MCP_TOOL ?? "browser_snapshot";
const toolArguments = JSON.parse(process.env.MCP_ARGS_JSON ?? "{}") as Record<string, unknown>;
const sequence = process.env.MCP_SEQUENCE_JSON
  ? JSON.parse(process.env.MCP_SEQUENCE_JSON) as Array<{ name: string; arguments?: Record<string, unknown> }>
  : [{ name: toolName, arguments: toolArguments }];
const timeoutMs = Number(process.env.MCP_TIMEOUT_MS ?? 30_000);
const sessionId = `browser-mcp-proof-${crypto.randomUUID().slice(0, 8)}`;

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
  target: process.env.DAYTONA_TARGET ?? "us",
});
const sandbox = await daytona.get(sandboxId);

await sandbox.process.createSession(sessionId);
const command = await sandbox.process.executeSessionCommand(
  sessionId,
  {
    command:
      "$HOME/.local/bin/playwright-mcp --cdp-endpoint http://127.0.0.1:9222 " +
      `--caps vision --image-responses omit --snapshot-mode ${snapshotMode} ` +
      "--timeout-action 10000 --timeout-navigation 30000 --timeout-settle 300 " +
      "--output-dir $HOME/work/.skynet-browser-proof",
    runAsync: true,
    suppressInputEcho: true,
  },
  20,
);

let consumedLines = 0;
async function request(id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  await sandbox.process.sendSessionCommandInput(
    sessionId,
    command.cmdId,
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await sandbox.process.getSessionCommandLogs(sessionId, command.cmdId);
    const lines = logs.stdout.split("\n");
    for (const line of lines.slice(consumedLines)) {
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (message.id === id) return message;
    }
    consumedLines = Math.max(consumedLines, lines.length - 1);
    await Bun.sleep(200);
  }
  throw new Error(`${method} timed out after ${timeoutMs}ms`);
}

try {
  const initialized = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "useagent-browser-proof", version: "1.0.0" },
  });
  if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
  await sandbox.process.sendSessionCommandInput(
    sessionId,
    command.cmdId,
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  for (const [index, tool] of sequence.entries()) {
    const startedAt = Date.now();
    const response = await request(index + 2, "tools/call", {
      name: tool.name,
      arguments: tool.arguments ?? {},
    });
    const result = response.result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
    const text = result?.content?.find((part) => part.type === "text")?.text ?? "";
    const summary = process.env.MCP_PRINT_TEXT === "1"
      ? text.slice(0, 5_000)
      : (result?.isError || response.error ? text : text.split("\n", 1)[0])?.slice(0, 600) ?? "";
    console.log(JSON.stringify({
      sandboxId,
      snapshotMode,
      toolName: tool.name,
      durationMs: Date.now() - startedAt,
      isError: Boolean(result?.isError || response.error),
      textChars: text.length,
      summary,
    }));
    if (result?.isError || response.error) break;
  }
} finally {
  await sandbox.process.deleteSession(sessionId).catch(() => {});
}
