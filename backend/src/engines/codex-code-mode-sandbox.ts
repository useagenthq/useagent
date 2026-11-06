// Codex runs the model's code-mode JavaScript in a separate host process. For the
// subscription app-server, which runs on the backend, that host lives in the
// sandbox instead: it listens on loopback gRPC, and a small forwarder exposes it
// as a WebSocket that admits only the current run's bearer, whose SHA-256 sits in
// a private file the plane rewrites every run. The backend tunnels the
// app-server's gRPC through it (provider-connections/codex-code-mode-bridge.ts).
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";
import type { SandboxRuntimeLayout } from "../sandboxes/provider";
import { sandboxBunExecutable } from "./sandbox-bun";
import type { SandboxListenerOwner } from "./sandbox-listener-probe";

export const CODEX_CODE_MODE_HOST_PORT = 37_736;
/** Not 127.0.0.1: E2B's sandbox agent republishes 127.0.0.1 listeners on its
 * own address, which would put the host behind the sandbox preview. Only the
 * forwarder below may reach it. */
export const CODEX_CODE_MODE_HOST_ADDRESS = "127.0.0.2";
export const CODEX_CODE_MODE_FORWARDER_PORT = 37_737;
export const CODEX_CODE_MODE_SESSION = `${SANDBOX_NAME_PREFIX}-codex-code-mode`;

/** Runs under the sandbox's Bun: `bun <this file> <listenPort> <hostAddress> <hostPort> <tokenSha256File>`. */
export const CODEX_CODE_MODE_FORWARDER_SOURCE = `
const { createHash, timingSafeEqual } = require("node:crypto");
const [listenPort, hostAddress, hostPort, tokenFile] = process.argv.slice(2);
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest();
const admitted = async (request) => {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = await Bun.file(tokenFile).text().then((text) => text.trim(), () => "");
  if (!token || !/^[0-9a-f]{64}$/.test(expected)) return false;
  return timingSafeEqual(digest(token), Buffer.from(expected, "hex"));
};
const write = (tcp, chunk) => {
  if (tcp.data.out.length > 0) return void tcp.data.out.push(chunk);
  const written = tcp.write(chunk);
  if (written < chunk.byteLength) tcp.data.out.push(chunk.subarray(Math.max(written, 0)));
};
const flush = (tcp) => {
  while (tcp.data.out.length > 0) {
    const chunk = tcp.data.out[0];
    const written = tcp.write(chunk);
    if (written < chunk.byteLength) {
      tcp.data.out[0] = chunk.subarray(Math.max(written, 0));
      return;
    }
    tcp.data.out.shift();
  }
};
Bun.serve({
  hostname: "0.0.0.0",
  port: Number(listenPort),
  async fetch(request, server) {
    if (!(await admitted(request))) return new Response("forbidden", { status: 403 });
    return server.upgrade(request, { data: { tcp: null, pending: [], pendingBytes: 0 } })
      ? undefined
      : new Response("websocket upgrade required", { status: 426 });
  },
  websocket: {
    open(ws) {
      Bun.connect({
        hostname: hostAddress,
        port: Number(hostPort),
        data: { ws, out: [] },
        socket: {
          open(tcp) {
            ws.data.tcp = tcp;
            for (const chunk of ws.data.pending.splice(0)) write(tcp, chunk);
            ws.data.pendingBytes = 0;
          },
          data(_tcp, chunk) { ws.sendBinary(chunk); },
          drain(tcp) { flush(tcp); },
          close() { ws.close(1011, "code-mode host closed"); },
          error() { ws.close(1011, "code-mode host failed"); },
        },
      }).catch(() => ws.close(1011, "code-mode host unreachable"));
    },
    message(ws, message) {
      const chunk = typeof message === "string" ? Buffer.from(message) : message;
      if (ws.data.tcp) return void write(ws.data.tcp, chunk);
      ws.data.pendingBytes += chunk.byteLength;
      if (ws.data.pendingBytes > MAX_PENDING_BYTES) return void ws.close(1009, "pending limit exceeded");
      ws.data.pending.push(chunk);
    },
    close(ws) { ws.data.tcp?.end(); },
  },
});
`;

export function codexCodeModeSandboxPaths(layout: SandboxRuntimeLayout) {
  const prefix = layout.runsAsRoot ? "/usr/local" : `${layout.home}/.local`;
  const directory = `${layout.home}/.useagent`;
  return {
    nativeRoot: `${prefix}/share/useagent/native-engines`,
    directory,
    forwarder: `${directory}/code-mode-forwarder.js`,
    tokenFile: `${directory}/code-mode-forwarder.sha256`,
    bun: sandboxBunExecutable(layout),
  };
}

/** The code-mode host, then the forwarder, as the processes that must own their ports. */
export function codexCodeModeOwners(layout: SandboxRuntimeLayout): readonly SandboxListenerOwner[] {
  const paths = codexCodeModeSandboxPaths(layout);
  return [
    {
      address: CODEX_CODE_MODE_HOST_ADDRESS,
      port: CODEX_CODE_MODE_HOST_PORT,
      executable: "codex-code-mode-host",
      installRoot: paths.nativeRoot,
      args: ["--listen", `grpc://${CODEX_CODE_MODE_HOST_ADDRESS}:${CODEX_CODE_MODE_HOST_PORT}`],
    },
    {
      address: "0.0.0.0",
      port: CODEX_CODE_MODE_FORWARDER_PORT,
      executablePath: paths.bun,
      args: [
        paths.forwarder,
        String(CODEX_CODE_MODE_FORWARDER_PORT),
        CODEX_CODE_MODE_HOST_ADDRESS,
        String(CODEX_CODE_MODE_HOST_PORT),
        paths.tokenFile,
      ],
    },
  ];
}

/** Admit only `tokenSha256` at the forwarder from now on (written atomically, 0600). */
export function buildCodexCodeModeTokenCommand(tokenSha256: string, layout: SandboxRuntimeLayout): string {
  if (!/^[0-9a-f]{64}$/.test(tokenSha256)) throw new Error("code-mode bearer digest is invalid");
  const paths = codexCodeModeSandboxPaths(layout);
  return [
    `install -d -m 700 ${JSON.stringify(paths.directory)}`,
    `(umask 077; printf '%s\\n' ${tokenSha256} > ${JSON.stringify(`${paths.tokenFile}.tmp`)})`,
    `mv -f ${JSON.stringify(`${paths.tokenFile}.tmp`)} ${JSON.stringify(paths.tokenFile)}`,
  ].join(" && ");
}

/** Start whichever of the host and forwarder is not running; the shell stays as the host. */
export function buildCodexCodeModeLaunchCommand(
  layout: SandboxRuntimeLayout,
  start: { readonly host: boolean; readonly forwarder: boolean },
): string {
  const paths = codexCodeModeSandboxPaths(layout);
  const [host, forwarder] = codexCodeModeOwners(layout);
  const forwarderArgs = forwarder!.args.map((arg) => JSON.stringify(arg)).join(" ");
  return [
    "set -eu",
    `install -d -m 700 ${JSON.stringify(paths.directory)}`,
    ...(start.forwarder
      ? [
          `printf %s '${Buffer.from(CODEX_CODE_MODE_FORWARDER_SOURCE, "utf8").toString("base64")}' | base64 -d > ${JSON.stringify(paths.forwarder)}`,
          `chmod 600 ${JSON.stringify(paths.forwarder)}`,
          `${JSON.stringify(paths.bun)} ${forwarderArgs} &`,
        ]
      : []),
    ...(start.host
      ? [
          'CODE_MODE_HOST=""',
          `for candidate in ${JSON.stringify(paths.nativeRoot)}/node_modules/@openai/codex-linux-*/vendor/*/bin/codex-code-mode-host; do if [ -x "$candidate" ]; then CODE_MODE_HOST="$candidate"; fi; done`,
          'test -n "$CODE_MODE_HOST"',
          `exec "$CODE_MODE_HOST" ${host!.args.map((arg) => JSON.stringify(arg)).join(" ")}`,
        ]
      : ["wait"]),
  ].join("\n");
}
