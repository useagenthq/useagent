import { Hono } from "hono";
import { websocket } from "hono/bun";
import { cors } from "hono/cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { auth } from "./auth";
import { artifactRoutes } from "./artifacts/routes";
import { startEmailConnector } from "./connectors/email";
import { db } from "./db/client";
import type { AppEnv } from "./http";
import {
  allowDevOrg,
  connectorEmailConfig,
  env,
  githubConfigured,
  googleAuthEnabled,
  memoryConfig,
  slackConfig,
} from "./env";
import { isPublicApiPath, orgScope } from "./middleware/org";
import { chatRoutes } from "./chat/routes";
import { toolGatewayConfig } from "./knowledge/gateway/config";
import { knowledgeRoutes } from "./knowledge/routes";
import { memoryRoutes } from "./memory/routes";
import { commandsRoutes } from "./runs/command-catalog";
import { reposRoutes } from "./github/routes";
import { pullsRoutes } from "./github/pulls-routes";
import { desktopProxyRoutes } from "./runs/desktop-proxy";
import { fleetRoutes } from "./runs/fleet-routes";
import { liveProxyRoutes } from "./runs/live-proxy";
import { recoverStaleRuns, startReconcileLoop } from "./runs/recovery";
import { runsRoutes } from "./runs/routes";
import { terminalRoutes } from "./runs/terminal";
import { schedulesRoutes } from "./schedules/routes";
import { startScheduler } from "./schedules/scheduler";
import { startCaptureDelivery } from "./memory/capture-outbox";
import { sandboxProvider, sandboxProviderApiKey, sandboxProviderKind } from "./sandboxes/provider";
import {
  resetStuckCanonicalization,
  startCanonicalizationOutbox,
} from "./runs/canonicalization-outbox";
import { secretsRoutes } from "./secrets/routes";
import { seedDev } from "./seed";
import { skillImportRoutes } from "./skills/import-routes";
import { skillsRoutes } from "./skills/routes";
import { slackEnabled, slackRoutes, startSlackOutbox } from "./slack";
import { enforceSingleBackend } from "./db/single-backend";
import { ensureWarmPool, warmPoolSize } from "./sandboxes/warm-pool";
import {
  cubeT3WarmPoolSize,
  cubeWarmPoolSize,
  startCubeWarmPool,
} from "./sandboxes/cube-warm-pool";
import { providerGatewaySandboxLabels } from "./provider-gateway/sandbox-config";
import { prewarmOpenCodeRuntime } from "./engines/opencode-server";
import {
  T3_CUBE_WARM_POOL_NAME,
  T3_RUNTIME_GENERATION,
  T3_RUNTIME_GENERATION_LABEL,
} from "./engines/t3-environment";
import { prewarmT3EnvironmentAccess } from "./engines/t3-environment-client";
import { prewarmT3ProviderBridge } from "./engines/t3-provider-bridge";
import { providerConnectionsRoutes } from "./provider-connections/routes";
import { codexSubscriptionRelayRoutes } from "./provider-connections/codex-subscription-relay";
import { wikiGenRoutes } from "./wiki-gen/routes";
import { engineModelsForReadyEngines, readyUserFacingEngines } from "./runs/engine-readiness";
import { uploadRoutes } from "./uploads/routes";
import { startUploadCleanup } from "./uploads/cleanup";
import { internalAutomationRoutes } from "./schedules/internal-routes";
import {
  gatewayApprovalRoutes,
  internalGatewayApprovalRoutes,
} from "./knowledge/gateway/approval-routes";

// Apply committed Drizzle migrations BEFORE anything reads or seeds the schema,
// so a fresh clone (or a fresh database) boots with the tables in place. The
// migrator is idempotent — already-applied migrations are skipped. Path is
// resolved from this module so cwd doesn't matter.
await migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });

// Single-backend guard: canonicalization sealing + realtime SSE fan-out are process-local
// (single-replica). Acquire the per-database singleton advisory lock BEFORE recovering or
// mutating runs, so a duplicate replica can't split the realtime lane or reconcile another
// backend's in-flight runs. Warn-and-continue by default (dev/test-safe); fatal only when
// the release sets REQUIRE_SINGLE_BACKEND=1.
await enforceSingleBackend();

// Idempotent boot seeding: dev org/user/member only. No demo content — the
// Knowledge and Skills surfaces start empty and fill with real records.
await seedDev();

// Recover orphaned runs from a previous (unclean) shutdown: reconcile the ones
// whose native opencode session actually finished server-side, fail the rest
// with an honest resumable summary. One-shot, self-bounded — never hangs boot.
const recovery = await recoverStaleRuns();
if (
  recovery.reconciled > 0 ||
  recovery.failed > 0 ||
  recovery.redispatched > 0 ||
  recovery.parked > 0
) {
  console.log(
    `[boot] command-lane recovery — ${recovery.reconciled} reconciled, ` +
      `${recovery.failed} failed, ${recovery.redispatched} re-dispatched, ` +
      `${recovery.parked} parked for re-probe`,
  );
}

// Canonicalization-outbox boot recovery: a crash mid-translate strands a
// `translating` row. Reset it to `pending` so the worker retries — SAFE because
// canonicalization is an idempotent full replace while still provisional.
const canonReset = await resetStuckCanonicalization();
if (canonReset > 0)
  console.log(`[boot] canonicalization recovery — ${canonReset} stuck rows re-armed`);

const app = new Hono<AppEnv>();

// CORS for the frontend, with credentials so cookie sessions flow when the
// browser calls the backend directly (the Next dev proxy is same-origin).
app.use(
  "/api/*",
  cors({
    origin: env.FRONTEND_ORIGIN,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);

// Universal auth adapter (fail CLOSED by default). Every /api/* request is
// org-session scoped UNLESS its prefix self-authenticates or is public
// (isPublicApiPath). A NEW router therefore needs no auth wiring to be
// protected - forgetting `.use(orgScope)` no longer leaves it open, it just
// runs behind the adapter. orgScope is idempotent, so the per-router guards that
// remain are free defense-in-depth. This runs before every mounted route below.
app.use("/api/*", async (c, next) => {
  if (isPublicApiPath(c.req.path)) return next();
  return orgScope(c, next);
});

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.route("/api/internal/automation", internalAutomationRoutes);
app.route("/api/internal/gateway-approval/consume", internalGatewayApprovalRoutes);
app.route("/api/internal/codex-relay", codexSubscriptionRelayRoutes);

// Public client config — what the frontend needs to render auth affordances
// (which social providers are enabled) without exposing any secret. `allowDevOrg`
// lets the UI reflect that unauthenticated dev access is currently open.
// `capabilities` are honest config-gated booleans (a name is NOT a secret) so
// surfaces like /agent/plugins can show what is actually wired vs not.
app.get("/api/config", (c) => {
  // Which agent engines are ACTUALLY selectable. This is stricter than the raw
  // ENABLED_ENGINES flag: optional engines must also be readiness-proven, and an
  // explicit provider health failure removes the engine from the public picker.
  // mock/daytona/claude-sdk/acp remain internal ids.
  const engines = readyUserFacingEngines();
  const models = engineModelsForReadyEngines();
  return c.json({
    auth: { google: googleAuthEnabled(), emailPassword: true },
    allowDevOrg: allowDevOrg(),
    engines,
    models,
    sandbox: { provider: sandboxProviderKind() },
    capabilities: {
      github: githubConfigured(),
      slack: slackConfig() !== null,
      memory: memoryConfig() !== null,
      toolGateway: toolGatewayConfig() !== null,
    },
  });
});

// better-auth: email/password + organization plugin, mounted at /api/auth/*.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Lightweight Chat (#122): a NO-SANDBOX conversational surface at /. Streams a
// model completion directly (OpenRouter), augmented with read-only retrieval
// (org knowledge + published wiki + team memory). Org-scoped; inert without
// OPENROUTER_API_KEY (503). Distinct from /api/runs (which spins sandboxes).
app.route("/api/chat", chatRoutes);

app.route("/api/runs", runsRoutes);
// Session-authenticated human approval minting. This stays on the product API;
// the sandbox-reachable gateway can only consume the resulting exact capability.
app.route("/api/gateway/approvals", gatewayApprovalRoutes);
// Durable run artifacts. The backend owns the immutable bytes and authorization;
// browsers and connector deliveries resolve the same artifact id.
app.route("/api/artifacts", artifactRoutes);
// User-selected files are durable before a run exists, then atomically claimed
// during command acceptance and materialized into the isolated sandbox.
app.route("/api/uploads", uploadRoutes);
// Interactive terminal WS bridge (browser xterm ⇄ sandbox PTY). Mounted before
// nothing — separate router so the SSE/step routes stay untouched.
app.route("/api/runs", terminalRoutes);
// Same-origin bridge to a thread's opencode server for the embedded "Live" tab
// (frontend/public/opencode-app). Injects the Daytona preview token, streams
// SSE through untouched.
app.route("/api/live-proxy", liveProxyRoutes);
// Same-origin bridge to a thread's noVNC desktop for the "Desktop" tab — proxies
// noVNC's static app over HTTP and its RFB WebSocket, injecting the Daytona
// preview token on both (shares the `websocket` handler above).
app.route("/api/desktop-proxy", desktopProxyRoutes);
// Real GitHub repository list for the New Task composer's repo picker. The
// backend-held token stays server-side; unconfigured → {configured:false}.
app.route("/api/repos", reposRoutes);
// Real open pull requests across the org's accessible repos - powers the
// /review page. Org-scoped; the GitHub token stays server-side. Unconfigured →
// {configured:false}; a failed fetch → {configured:true, error}.
app.route("/api/pulls", pullsRoutes);
// Real "Limits" numbers for the workspace: per-model token/cost burn today +
// the org's live Daytona sandbox footprint. Org-scoped; no keys to the client.
app.route("/api/fleet", fleetRoutes);
// multi-repo skill import from the org's GitHub repos (scan + import). Mounted
// before /api/skills so the /import subtree resolves to its own routes.
app.route("/api/skills/import", skillImportRoutes);
app.route("/api/skills", skillsRoutes);
app.route("/api/automations", schedulesRoutes);
// Backward-compatible alias for sessions and frontend bundles created before
// the product surface was renamed to Automations.
app.route("/api/schedules", schedulesRoutes);
// Org Secrets — encrypted named secrets injected as env vars into the per-thread
// sandbox at boot. Org-scoped; values are write-only at this boundary (set/delete
// only, never returned). See src/secrets/*.
app.route("/api/secrets", secretsRoutes);
// User-scoped provider credentials. Values are encrypted at rest and write-only
// over HTTP; trusted backend consumers use src/provider-connections/service.ts.
app.route("/api/provider-connections", providerConnectionsRoutes);
app.route("/api/knowledge", knowledgeRoutes);
// Repo-wiki generator: POST /api/wiki/generate clones an offered repo and lands
// a per-page architecture wiki as org-scoped published documents + immutable
// revisions (searchable via knowledge_search). Org-scoped; regeneration diffs
// against prior revisions. Inert without OPENROUTER_API_KEY (503).
app.route("/api/wiki", wikiGenRoutes);
// Memory Hub — human control surface over the team-memory pools (browse/search/
// correct/delete), the capture outbox (inspect + manual recovery), and the
// retrieval ledger. Org-scoped; memory transport credentials stay server-side.
app.route("/api/memory", memoryRoutes);
// Snapshot-level slash-command catalog (cached from the live-proxy's /command
// taps) — powers "/" autocomplete on the New Task composer before a sandbox
// exists.
app.route("/api/commands", commandsRoutes);

// Always-on scheduler loop (60s tick). Harmless when no schedule is enabled —
// Automations default disabled, so nothing auto-fires until a human turns it on.
startScheduler();

// Abandoned pre-run uploads expire after 24h. Reclaim only their metadata;
// content-addressed bytes may still be referenced by another durable record.
startUploadCleanup();

// Memory capture-outbox delivery loop (15s tick). Delivers each completed run's
// queued outcome to team memory with retry/backoff/dead-letter; harmless when
// memory is disabled (deliverTeamMemory no-ops). AT-MOST-once (crash-orphaned
// `delivering` rows await manual inspection, never auto-retried).
startCaptureDelivery();

// Canonical-lane outbox delivery loop (1s tick, final_harness Phase 1). Drains
// each settled run's enqueued canonicalization: translates the native source to
// canonical events with a source-watermark stability check, replaces provisional
// rows, and marks `complete` only when the whole source was translated. Harmless
// when nothing is due; multi-instance safe (FOR UPDATE SKIP LOCKED claim).
startCanonicalizationOutbox();

// Adaptive post-boot reconciler (#63, 15s tick). Re-probes runs PARKED by boot
// recovery (native session may still be finishing after a fast restart): adopts
// the finished session, honest-fails after the ~5min budget. Single-flight;
// harmless when nothing is parked.
startReconcileLoop();

// Daytona warm pool for the OpenCode snapshot (perf plan Phase 3), OFF by
// default. Only when DAYTONA_WARM_POOL_SIZE is set AND an explicit OpenCode
// snapshot (DAYTONA_SNAPSHOT) is configured do we provision/reconcile a pool so
// new-thread creates claim a ready machine instead of building one (gate:
// sandbox usable p95 <1.5s). Best-effort and fire-and-forget: a pool error never
// blocks boot or any turn.
const warmPoolTarget = warmPoolSize();
const openCodeSnapshot = process.env.DAYTONA_SNAPSHOT?.trim();
if (sandboxProviderKind() === "daytona" && warmPoolTarget && openCodeSnapshot) {
  void ensureWarmPool(openCodeSnapshot, warmPoolTarget)
    .then((pool) =>
      console.log(
        `[warm-pool] opencode ${pool.snapshot} target=${pool.target} ready=${pool.ready}/${pool.desired}`,
      ),
    )
    .catch((err) =>
      console.warn("[warm-pool] ensure failed:", err instanceof Error ? err.message : err),
    );
}

const cubePoolTarget = cubeWarmPoolSize();
const cubeTemplate = process.env.CUBE_TEMPLATE_ID?.trim();
if (sandboxProviderKind() === "cube" && cubePoolTarget && cubeTemplate) {
  const apiKey = sandboxProviderApiKey();
  const autoStopInterval = Number(process.env.SANDBOX_AUTO_STOP_MIN ?? 30);
  const autoDeleteInterval = Number(process.env.SANDBOX_AUTO_DELETE_MIN ?? 4320);
  startCubeWarmPool({
    provider: sandboxProvider(apiKey),
    size: cubePoolTarget,
    createOptions: {
      snapshot: cubeTemplate,
      labels: providerGatewaySandboxLabels("warm-pool"),
      autoStopInterval,
      autoDeleteInterval,
    },
    warmRuntime: async (sandbox, signal) => {
      await prewarmOpenCodeRuntime(sandbox, signal);
    },
  });
  console.log(`[cube-warm-pool] target=${cubePoolTarget} template=${cubeTemplate}`);
}

const cubeT3PoolTarget = cubeT3WarmPoolSize();
const cubeT3Template = process.env.T3_CUBE_TEMPLATE_ID?.trim();
if (sandboxProviderKind() === "cube" && cubeT3PoolTarget && cubeT3Template) {
  const apiKey = sandboxProviderApiKey();
  const autoStopInterval = Number(process.env.SANDBOX_AUTO_STOP_MIN ?? 30);
  const autoDeleteInterval = Number(process.env.SANDBOX_AUTO_DELETE_MIN ?? 4320);
  startCubeWarmPool({
    name: T3_CUBE_WARM_POOL_NAME,
    provider: sandboxProvider(apiKey),
    size: cubeT3PoolTarget,
    requireDesktop: false,
    createOptions: {
      snapshot: cubeT3Template,
      labels: {
        ...providerGatewaySandboxLabels(`warm-pool:${T3_RUNTIME_GENERATION}`),
        [T3_RUNTIME_GENERATION_LABEL]: T3_RUNTIME_GENERATION,
      },
      autoStopInterval,
      autoDeleteInterval,
    },
    warmRuntime: async (sandbox, signal) => {
      const t3PrewarmEnv = { ...process.env, T3_ENVIRONMENT_ENABLED: "true" };
      await prewarmT3ProviderBridge(sandbox, t3PrewarmEnv);
      await Promise.all([
        prewarmT3EnvironmentAccess(sandbox, signal),
        prewarmOpenCodeRuntime(sandbox, signal),
      ]);
    },
  });
  console.log(
    `[cube-warm-pool:${T3_CUBE_WARM_POOL_NAME}] target=${cubeT3PoolTarget} template=${cubeT3Template}`,
  );
}

// Slack adapter: mounted only when SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET are
// set (env-gated). Handles the Events API at POST /api/slack/events, and starts
// the durable outbox relay (boot recovery of undelivered replies + retry loop).
if (slackEnabled()) {
  app.route("/api/slack", slackRoutes);
  startSlackOutbox();
  console.log("[slack] adapter enabled — POST /api/slack/events (durable outbox)");
}

// Email connector: mounted only when CONNECTOR_EMAIL_NOTIFY (all|failed) + a
// from/to are set (env-gated). Watches every run completion and delivers a
// digest per policy; CONNECTOR_EMAIL_DRYRUN=true logs the payload instead.
const emailConnector = connectorEmailConfig();
if (emailConnector) {
  startEmailConnector(emailConnector);
  console.log(
    `[connectors] email enabled — notify=${emailConnector.notify}${
      emailConnector.dryRun ? " (dry-run)" : ""
    }`,
  );
}

console.log(`[skynet] backend listening on http://localhost:${env.PORT}`);

export default {
  hostname: "127.0.0.1",
  port: env.PORT,
  fetch: app.fetch,
  // Bun WebSocket handler for the terminal bridge (hono/bun upgradeWebSocket).
  websocket,
  // Long-held requests are legitimate here: the Live tab's prompt POST stays
  // open for a whole engine turn through /api/live-proxy. Bun's 10s default
  // idle timeout kills them ("Failed to fetch" in opencode's composer); 255s
  // is Bun's maximum. Turns longer than that keep running server-side — only
  // the embed's request errors.
  idleTimeout: 255,
};
