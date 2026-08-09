/**
 * Reproducible live wrapper for the Phase 8 retained-session journey with the
 * provider gateway enabled. It exposes only the narrow gateway through a fresh
 * cloudflared URL, then runs one engine against its isolated Phase 8 database.
 * Phase 8 owns sandbox/DB cleanup; this wrapper owns the gateway and tunnel.
 *
 *   E2E_ENGINE=opencode bun test/e2e/provider-gateway-live.ts
 *   E2E_ENGINE=claude   bun test/e2e/provider-gateway-live.ts
 *   E2E_ENGINE=codex    bun test/e2e/provider-gateway-live.ts
 *   E2E_ENGINE=codex E2E_JOURNEY=c6 bun test/e2e/provider-gateway-live.ts
 */
import { closeSync, openSync } from "node:fs";
import { stopOwnedProcesses } from "./lib/process-lifecycle";
import {
  startPublicTunnel,
  tunnelProviderOrder,
  waitForPublicHttp,
  type TunnelProvider,
} from "./lib/public-tunnel";

type Engine = "opencode" | "claude" | "codex";
type Journey = "phase8" | "c6";

const engine = (process.env.E2E_ENGINE ?? "opencode") as Engine;
if (!(["opencode", "claude", "codex"] as const).includes(engine)) {
  throw new Error(`unsupported E2E_ENGINE: ${engine}`);
}
const journey = (process.env.E2E_JOURNEY ?? "phase8") as Journey;
if (!(journey === "phase8" || journey === "c6")) {
  throw new Error(`unsupported E2E_JOURNEY: ${journey}`);
}

const gatewayPortByJourney: Record<Journey, Record<Engine, number>> = {
  phase8: { opencode: 3542, claude: 3543, codex: 3544 },
  c6: { opencode: 3552, claude: 3553, codex: 3554 },
};
const gatewayPort = gatewayPortByJourney[journey][engine];
const gatewayBase = `http://localhost:${gatewayPort}`;
const dbName = journey === "phase8" ? `skynet_e2e_p8_${engine}` : `skynet_e2e_c6_${engine}`;
const dbUrl = `postgres://postgres@localhost:5432/${dbName}`;
const backendDir = new URL("../..", import.meta.url).pathname;
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const gatewayLog = `${scratch}/skynet-provider-${engine}-gateway.log`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const providerSigningSecret = `provider-live-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const toolSigningSecret = `tool-live-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const secretsEncryptionKey = `encryption-live-${crypto.randomUUID()}-${crypto.randomUUID()}`;

type Child = ReturnType<typeof Bun.spawn>;

function tunnelLog(provider: TunnelProvider): string {
  return `${scratch}/skynet-provider-${engine}-${provider}-tunnel.log`;
}

async function waitForHealth(
  url: string,
  budgetMs: number,
  logPath: string,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup race; retry inside the bounded deadline.
    }
    await sleep(500);
  }
  throw new Error(`gateway did not become healthy at ${url}; see ${logPath}`);
}

async function startTunnel(
  provider: TunnelProvider,
): Promise<{ child: Child; publicUrl: string; logPath: string }> {
  const logPath = tunnelLog(provider);
  const tunnel = await startPublicTunnel({ localPort: gatewayPort, logPath, provider });
  return { child: tunnel.process as Child, publicUrl: tunnel.publicUrl, logPath };
}

function startGateway(publicUrl: string): Child {
  const fd = openSync(gatewayLog, "w");
  try {
    return Bun.spawn(["bun", "src/gateway.ts"], {
      cwd: backendDir,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl,
        GATEWAY_PORT: String(gatewayPort),
        PROVIDER_GATEWAY_PUBLIC_URL: publicUrl,
        GATEWAY_PUBLIC_URL: "",
        PROVIDER_GATEWAY_SECRET: providerSigningSecret,
        TOOL_GATEWAY_SECRET: toolSigningSecret,
        SECRETS_ENCRYPTION_KEY: secretsEncryptionKey,
        SKYNET_DEV_MODE: "true",
      },
      stdout: fd,
      stderr: fd,
    });
  } finally {
    closeSync(fd);
  }
}

const tunnelProviders = tunnelProviderOrder(process.env.E2E_TUNNEL_PROVIDER);

let tunnel: Child | null = null;
let gateway: Child | null = null;

try {
  let publicUrl = "";
  let lastError: unknown = null;
  for (const provider of tunnelProviders) {
    try {
      const started = await startTunnel(provider);
      tunnel = started.child;
      gateway = startGateway(started.publicUrl);
      await waitForHealth(`${gatewayBase}/api/health`, 20_000, gatewayLog);
      // Authoritative reachability gate: DNS (IPv4 or IPv6), TLS, tunnel routing,
      // and the narrow gateway response. Anonymous Cloudflare DNS occasionally
      // fails to publish despite a connected edge; localhost.run is the bounded
      // test-only fallback, never a production recommendation.
      await waitForPublicHttp(
        `${started.publicUrl}/api/health`,
        90_000,
        started.logPath,
      );
      publicUrl = started.publicUrl;
      console.log(`provider-gateway tunnel=${provider}`);
      break;
    } catch (error) {
      lastError = error;
      console.warn(`${provider} tunnel unavailable: ${String(error)}`);
      await stopOwnedProcesses([gateway, tunnel]);
      gateway = null;
      tunnel = null;
    }
  }
  if (!publicUrl) throw lastError ?? new Error("no tunnel provider became reachable");

  const productProbe = await fetch(`${publicUrl}/api/runs`).catch(() => null);
  if (!productProbe || productProbe.status !== 404) {
    throw new Error(`gateway leaked product surface /api/runs (HTTP ${productProbe?.status})`);
  }

  console.log(
    `PROVIDER_GATEWAY_LIVE journey=${journey} engine=${engine} origin=${publicUrl} ` +
      "surface=/api/health,/api/mcp/knowledge,/api/provider only",
  );
  const journeyProcess = Bun.spawn(
    ["bun", journey === "phase8" ? "test/e2e/phase8-journey.ts" : "test/e2e/c6-react-journey.ts"],
    {
    cwd: backendDir,
    env: {
      ...process.env,
      E2E_ENGINE: engine,
      PROVIDER_GATEWAY_PUBLIC_URL: publicUrl,
      GATEWAY_PUBLIC_URL: "",
      PROVIDER_GATEWAY_SECRET: providerSigningSecret,
      TOOL_GATEWAY_SECRET: toolSigningSecret,
      SECRETS_ENCRYPTION_KEY: secretsEncryptionKey,
      SKYNET_DEV_MODE: "true",
    },
    stdout: "inherit",
    stderr: "inherit",
    },
  );
  const exitCode = await journeyProcess.exited;
  if (exitCode !== 0) {
    throw new Error(`${journey} ${engine} journey failed with exit ${exitCode}`);
  }
} finally {
  await stopOwnedProcesses([gateway, tunnel]);
}
