import type { ProviderId } from "../provider-gateway/provider";
import type { ToolGatewayCapabilityDescriptor } from "../knowledge/gateway/descriptor";
import type { SandboxHandle } from "../sandboxes/provider";

export const PI_BROKER_PORT = 19483;

interface PiBrokerProviderCapability {
  readonly provider: ProviderId;
  readonly baseUrl: string;
  readonly bearerToken: string;
}

const BROKER_SCRIPT = String.raw`
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const [configPath, rawPort] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
fs.unlinkSync(configPath);

function targetFor(path) {
  const incoming = new URL(path, "http://127.0.0.1");
  const route = incoming.pathname.startsWith("/provider") ? config.provider : incoming.pathname.startsWith("/mcp") ? config.mcp : null;
  if (!route) return null;
  const prefix = incoming.pathname.startsWith("/provider") ? "/provider" : "/mcp";
  const target = new URL(route.url);
  const suffix = incoming.pathname.slice(prefix.length);
  target.pathname = target.pathname.replace(/\/$/, "") + suffix;
  target.search = incoming.search;
  return { target, authorization: route.authorization };
}

http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(204).end();
    return;
  }
  const route = targetFor(request.url || "/");
  if (!route) {
    response.writeHead(404).end();
    return;
  }
  const headers = { ...request.headers, host: route.target.host, authorization: route.authorization };
  const upstream = (route.target.protocol === "https:" ? https : http).request(route.target, {
    method: request.method,
    headers,
  }, (incoming) => {
    response.writeHead(incoming.statusCode || 502, incoming.headers);
    incoming.pipe(response);
  });
  upstream.on("error", (error) => response.writeHead(502).end(error.message));
  request.pipe(upstream);
}).listen(Number(rawPort), "127.0.0.1");
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function startPiCredentialBroker(input: {
  readonly sandbox: SandboxHandle;
  readonly provider: PiBrokerProviderCapability;
  readonly tools: ToolGatewayCapabilityDescriptor | null;
}): Promise<void> {
  const root = "/root/.useagent/pi-broker";
  const scriptPath = `${root}/broker.cjs`;
  const configPath = `${root}/capabilities.json`;
  const pidPath = `${root}/broker.pid`;
  const config = JSON.stringify({
    provider: {
      url: input.provider.baseUrl,
      authorization: `Bearer ${input.provider.bearerToken}`,
    },
    ...(input.tools
      ? { mcp: { url: input.tools.url, authorization: input.tools.authorizationHeader } }
      : {}),
  });
  const prepared = await input.sandbox.process.executeCommand(
    `install -d -m 700 ${shellQuote(root)}`,
    undefined,
    undefined,
    15,
  );
  if ((prepared.exitCode ?? 1) !== 0) throw new Error("failed to prepare Pi credential broker");
  await Promise.all([
    input.sandbox.fs.uploadFile(Buffer.from(BROKER_SCRIPT), scriptPath, 60),
    input.sandbox.fs.uploadFile(Buffer.from(config), configPath, 60),
  ]);
  const launched = await input.sandbox.process.executeCommand(
    `chmod 700 ${shellQuote(scriptPath)} && chmod 600 ${shellQuote(configPath)} && ` +
      `if test -s ${shellQuote(pidPath)}; then kill "$(cat ${shellQuote(pidPath)})" 2>/dev/null || true; fi; ` +
      `nohup node ${shellQuote(scriptPath)} ${shellQuote(configPath)} ${PI_BROKER_PORT} ` +
      `>${shellQuote(`${root}/broker.log`)} 2>&1 & echo $! > ${shellQuote(pidPath)}; ` +
      `i=0; while test "$i" -lt 50; do ` +
      `if curl -fsS -o /dev/null http://127.0.0.1:${PI_BROKER_PORT}/health && ! test -e ${shellQuote(configPath)}; then exit 0; fi; ` +
      `i=$((i + 1)); sleep 0.1; done; exit 1`,
    undefined,
    undefined,
    20,
  );
  if ((launched.exitCode ?? 1) !== 0) throw new Error("Pi credential broker did not become ready");
}
