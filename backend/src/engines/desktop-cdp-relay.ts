import { randomBytes } from "node:crypto";
import type { SandboxHandle } from "../sandboxes/provider";

export const DESKTOP_CDP_RELAY_PORT = 19_222;
export const DESKTOP_CDP_RELAY_VERSION = "1";

const RELAY_TOKEN_NAME = "cdp-relay.token";
const relayTokens = new Map<string, string>();

export function desktopCdpRelaySource(): string {
  return String.raw`import { timingSafeEqual } from "node:crypto";

const PORT = ${DESKTOP_CDP_RELAY_PORT};
const VERSION = ${JSON.stringify(DESKTOP_CDP_RELAY_VERSION)};
const TOKEN = (await Bun.file(new URL("./${RELAY_TOKEN_NAME}", import.meta.url)).text()).trim();

type RelayData = {
  readonly upstream: WebSocket;
  readonly pending: Array<string | ArrayBuffer | Uint8Array>;
};

function authorized(request: Request): boolean {
  const expected = Buffer.from("Bearer " + TOKEN);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function upstreamUrl(request: Request, protocol: "http:" | "ws:"): URL {
  const url = new URL(request.url);
  url.protocol = protocol;
  url.hostname = "127.0.0.1";
  url.port = "9222";
  return url;
}

Bun.serve<RelayData>({
  hostname: "0.0.0.0",
  port: PORT,
  fetch(request, server) {
    if (!authorized(request)) return new Response("unauthorized", { status: 401 });
    const path = new URL(request.url).pathname;
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!path.startsWith("/devtools/page/")) return new Response("not found", { status: 404 });
      const upstream = new WebSocket(upstreamUrl(request, "ws:"));
      if (server.upgrade(request, { data: { upstream, pending: [] } })) return;
      upstream.close();
      return new Response("upgrade failed", { status: 500 });
    }
    if (request.method !== "GET" || !["/json/list", "/json/version"].includes(path)) {
      return new Response("not found", { status: 404 });
    }
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("host");
    return fetch(upstreamUrl(request, "http:"), { headers }).then((response) => {
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("x-skynet-cdp-relay-version", VERSION);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    });
  },
  websocket: {
    open(client) {
      const { upstream, pending } = client.data;
      upstream.binaryType = "arraybuffer";
      const flush = () => {
        for (const message of pending.splice(0)) upstream.send(message);
      };
      if (upstream.readyState === WebSocket.OPEN) flush();
      else upstream.addEventListener("open", flush, { once: true });
      upstream.addEventListener("message", (event) => client.send(event.data));
      upstream.addEventListener("close", () => client.close());
      upstream.addEventListener("error", () => client.close(1011, "upstream error"));
    },
    message(client, message) {
      const { upstream, pending } = client.data;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push(message);
      else client.close(1011, "upstream unavailable");
    },
    close(client) {
      client.data.upstream.close();
    },
  },
});
`;
}

function validRelayToken(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function desktopCdpRelayProbeCommand(): string {
  return (
    "python3 -c \"import pathlib,urllib.request; " +
    "token=pathlib.Path.home().joinpath('.skynet/cdp-relay.token').read_text().strip(); " +
    `request=urllib.request.Request('http://127.0.0.1:${DESKTOP_CDP_RELAY_PORT}/json/version',headers={'authorization':'Bearer '+token}); ` +
    `response=urllib.request.urlopen(request,timeout=3); assert response.headers.get('x-skynet-cdp-relay-version') == '${DESKTOP_CDP_RELAY_VERSION}'\"`
  );
}

export function providerCdpRelayProbeCommand(): string {
  return 'awk \'$2 == "00000000:4B16" && $4 == "0A" { found=1 } END { exit found ? 0 : 1 }\' /proc/net/tcp';
}

export async function ensureDesktopCdpRelayFiles(
  sandbox: SandboxHandle,
  home: string,
): Promise<string> {
  const tokenPath = `${home}/.skynet/${RELAY_TOKEN_NAME}`;
  const existing = await sandbox.fs
    .downloadFile(tokenPath)
    .then((buffer) => buffer.toString("utf8").trim())
    .catch(() => "");
  const token = validRelayToken(existing) ? existing : randomBytes(32).toString("hex");
  await Promise.all([
    sandbox.fs.uploadFile(Buffer.from(desktopCdpRelaySource()), `${home}/.skynet/cdp-relay.ts`),
    existing === token
      ? Promise.resolve()
      : sandbox.fs.uploadFile(Buffer.from(`${token}\n`), tokenPath),
  ]);
  const permissions = await sandbox.process.executeCommand(
    'chmod 700 "$HOME/.skynet" && chmod 600 "$HOME/.skynet/cdp-relay.token"',
    undefined,
    undefined,
    5,
  );
  if (permissions.exitCode !== 0) throw new Error("browser control credential permissions failed");
  relayTokens.set(sandbox.id, token);
  return token;
}

export async function desktopCdpRelayToken(sandbox: SandboxHandle): Promise<string> {
  const cached = relayTokens.get(sandbox.id);
  if (cached) return cached;
  const result = await sandbox.process.executeCommand(
    'cat "$HOME/.skynet/cdp-relay.token"',
    undefined,
    undefined,
    5,
  );
  const token = result.result?.trim() ?? "";
  if (result.exitCode !== 0 || !validRelayToken(token)) {
    throw new Error("browser control credential is unavailable");
  }
  relayTokens.set(sandbox.id, token);
  return token;
}

export function resetDesktopCdpRelayTokensForTest(): void {
  relayTokens.clear();
}
