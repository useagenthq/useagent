import { randomBytes } from "node:crypto";
import type { SandboxHandle } from "../sandboxes/provider";

export const DESKTOP_CDP_RELAY_PORT = 19_222;
export const DESKTOP_CDP_RELAY_VERSION = "1";

const RELAY_TOKEN_NAME = "cdp-relay.token";
const relayTokens = new Map<string, string>();

export function desktopCdpRelaySource(): string {
  return String.raw`import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";

const PORT = ${DESKTOP_CDP_RELAY_PORT};
const VERSION = ${JSON.stringify(DESKTOP_CDP_RELAY_VERSION)};
const TOKEN = readFileSync(new URL("./${RELAY_TOKEN_NAME}", import.meta.url), "utf8").trim();

function authorized(request) {
  const expected = Buffer.from("Bearer " + TOKEN);
  const header = request.headers.authorization;
  const actual = Buffer.from(Array.isArray(header) ? header[0] ?? "" : header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function reject(response, status, body) {
  response.writeHead(status, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

const server = createServer((request, response) => {
  if (!authorized(request)) return reject(response, 401, "unauthorized");
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method !== "GET" || !["/json/list", "/json/version"].includes(path)) {
    return reject(response, 404, "not found");
  }
  const upstream = httpRequest({
    hostname: "127.0.0.1",
    port: 9222,
    path: request.url,
    method: "GET",
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, {
      ...upstreamResponse.headers,
      "x-skynet-cdp-relay-version": VERSION,
    });
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => reject(response, 502, "upstream unavailable"));
  upstream.end();
});

server.on("upgrade", (request, socket, head) => {
  if (!authorized(request)) return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (!path.startsWith("/devtools/page/")) {
    return socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  }
  const upstream = connect(9222, "127.0.0.1", () => {
    const headers = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      if (["authorization", "host"].includes(name.toLowerCase())) continue;
      headers.push(name + ": " + request.rawHeaders[index + 1]);
    }
    upstream.write("GET " + request.url + " HTTP/1.1\r\nHost: 127.0.0.1:9222\r\n" + headers.join("\r\n") + "\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, "0.0.0.0");
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
    sandbox.fs.uploadFile(Buffer.from(desktopCdpRelaySource()), `${home}/.skynet/cdp-relay.mjs`),
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
