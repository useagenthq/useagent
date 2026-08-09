import { closeSync, openSync, readFileSync } from "node:fs";
import { stopOwnedProcess, type OwnedProcess } from "./process-lifecycle";

export type TunnelProvider = "cloudflare" | "pinggy" | "localhost-run";

export interface PublicTunnel {
  readonly process: OwnedProcess;
  readonly provider: TunnelProvider;
  readonly publicUrl: string;
  readonly logPath: string;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function tunnelProviderOrder(raw: string | undefined): readonly TunnelProvider[] {
  if (!raw) return ["cloudflare", "pinggy", "localhost-run"];
  if (raw === "cloudflare" || raw === "pinggy" || raw === "localhost-run") {
    return [raw];
  }
  throw new Error(`unsupported E2E_TUNNEL_PROVIDER: ${raw}`);
}

function spawnLogged(command: string[], logPath: string): OwnedProcess {
  const descriptor = openSync(logPath, "w");
  try {
    return Bun.spawn(command, { stdout: descriptor, stderr: descriptor });
  } finally {
    closeSync(descriptor);
  }
}

async function waitForOrigin(logPath: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const match = readFileSync(logPath, "utf8").match(pattern);
    if (match?.[1]) return match[1];
    await delay(500);
  }
  throw new Error(`tunnel did not publish an origin; see ${logPath}`);
}

export async function startPublicTunnel(input: {
  readonly localPort: number;
  readonly logPath: string;
  readonly provider: TunnelProvider;
}): Promise<PublicTunnel> {
  const { localPort, logPath, provider } = input;
  const config =
    provider === "cloudflare"
      ? {
          command: [
            "cloudflared", "tunnel", "--no-autoupdate", "--protocol", "http2",
            "--url", `http://localhost:${localPort}`,
          ],
          pattern: /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i,
        }
      : provider === "pinggy"
        ? {
            command: [
              "ssh", "-p", "443", "-T", "-o", "StrictHostKeyChecking=accept-new",
              "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes",
              "-R", `0:localhost:${localPort}`, "a.pinggy.io",
            ],
            pattern: /(https:\/\/[a-z0-9-]+\.free\.pinggy\.net)/i,
          }
        : {
            command: [
              "ssh", "-T", "-o", "StrictHostKeyChecking=accept-new",
              "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes",
              "-R", `80:localhost:${localPort}`, "nokey@localhost.run",
            ],
            pattern: /(https:\/\/[a-z0-9.-]+\.lhr\.life)/i,
          };
  const process = spawnLogged(config.command, logPath);
  try {
    const publicUrl = await waitForOrigin(logPath, config.pattern);
    return { process, provider, publicUrl, logPath };
  } catch (error) {
    await stopOwnedProcess(process);
    throw error;
  }
}

/** Probe through curl so DNS, TLS and edge routing—not just local fetch—are exercised. */
export async function waitForPublicHttp(
  url: string,
  budgetMs: number,
  logPath: string,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    const probe = Bun.spawn(
      ["curl", "--fail", "--silent", "--show-error", "--max-time", "10", url],
      { stdout: "ignore", stderr: "pipe" },
    );
    const exitCode = await probe.exited;
    if (exitCode === 0) return;
    lastError = (await new Response(probe.stderr).text()).trim() || `curl exit ${exitCode}`;
    await delay(1_000);
  }
  throw new Error(
    `public endpoint did not become healthy at ${url}: ${lastError}; see ${logPath}`,
  );
}
