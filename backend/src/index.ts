import { Hono } from "hono";
import { websocket } from "hono/bun";
import { cors } from "hono/cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ARTIFACT_FIDELITY } from "@useagent/artifact-workspace";
import { auth } from "./auth";
import { artifactRoutes } from "./artifacts/routes";
import { internalArtifactChangeRoutes } from "./artifacts/internal-change-routes";
import { startEmailConnector } from "./connectors/email";
import { client, db } from "./db/client";
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
import { bearerAuth } from "./middleware/bearer";
import { chatRoutes } from "./chat/routes";
import { toolGatewayConfig } from "./knowledge/gateway/config";
import { knowledgeRoutes } from "./knowledge/routes";
import { knowledgeDraftRoutes, skillProposalRoutes } from "./learning/routes";
import { memoryRoutes } from "./memory/routes";
import { commandsRoutes } from "./runs/command-catalog";
import { createOperatorRoutes } from "./runs/operator-routes";
import { reposRoutes } from "./github/routes";
import { pullsRoutes } from "./github/pulls-routes";
import { desktopProxyRoutes } from "./runs/desktop-proxy";
import { fleetRoutes } from "./runs/fleet-routes";
import { liveProxyRoutes } from "./runs/live-proxy";
import { recoverStaleRuns, startReconcileLoop } from "./runs/recovery";
import {
  reconcileFleetOnBoot,
  startFleetReconciler,
} from "./fleet/reconciler";
import { pumpThread, signalCancel } from "./worker";
import { handleRunCreate, runsRoutes } from "./runs/routes";
import { terminalRoutes } from "./runs/terminal";
import { schedulesRoutes } from "./schedules/routes";
import { startScheduler } from "./schedules/scheduler";
import { startCaptureDelivery } from "./memory/capture-outbox";
import { resetStuckLearning, startLearningOutbox } from "./learning/learning-outbox";
import { sandboxProvider, sandboxProviderApiKey, sandboxProviderKind } from "./sandboxes/provider";
import {
  resetStuckCanonicalization,
  startCanonicalizationOutbox,
} from "./runs/canonicalization-outbox";
import { startCodeIndex } from "./context/code/index-sweep";
import { secretsRoutes } from "./secrets/routes";
import { apiKeysRoutes } from "./api-keys/routes";
import { seedDev } from "./seed";
import { skillImportRoutes } from "./skills/import-routes";
import { startSkillsResync } from "./skills/resync";
import { skillsRoutes } from "./skills/routes";
import { slackEnabled, slackRoutes, startSlackOutbox, syncSlackWorkspaceBindings } from "./slack";
import { enforceSingleBackend } from "./db/single-backend";
import { ensureWarmPool, warmPoolSize } from "./sandboxes/warm-pool";
import {
  cubeRuntimeWarmPoolSize,
  cubeWarmPoolSize,
  startCubeWarmPool,
} from "./sandboxes/cube-warm-pool";
import { providerGatewaySandboxLabels } from "./provider-gateway/sandbox-config";
import { prewarmOpenCodeRuntime } from "./engines/opencode-server";
import {
  RUNTIME_CUBE_WARM_POOL_NAME,
  RUNTIME_GENERATION,
  RUNTIME_GENERATION_LABEL,
} from "./engines/runtime-environment";
import { prewarmRuntimeEnvironmentAccess } from "./engines/runtime-environment-client";
import { operatorEnv } from "./engines/runtime-env";
import { prewarmRuntimeProviderBridge } from "./engines/runtime-provider-bridge";
import { providerConnectionsRoutes } from "./provider-connections/routes";
import { integrationRoutes } from "./integrations/routes";
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
import { internalApprovalRequestRoutes } from "./knowledge/gateway/approval-request-tools";
import { approveApprovalRequestAsRunOwner } from "./knowledge/gateway/approval-requests";
import { currentReleaseFingerprint, isClientReleaseCompatible } from "./release";
import { dashboardRoutes } from "./dashboard/routes";

// Acquire the per-database singleton before ANY shared-state mutation. In strict
// production mode an unavailable/contended lock fails boot closed, so a duplicate
// process cannot migrate or recover another backend's database first.
await enforceSingleBackend();

// Apply committed Drizzle migrations BEFORE anything reads or seeds the schema,
// so a fresh clone (or a fresh database) boots with the tables in place. The
// migrator is idempotent — already-applied migrations are skipped. Path is
// resolved from this module so cwd doesn't matter.
await migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });

// Reconcile the restricted gateway role's grants on EVERY boot: a migration
// that adds a gateway-written table ships its grant in the same commit (see
// db/gateway-grants.ts for the incident class this kills).
const { applyGatewayGrants } = await import("./db/gateway-grants");
await applyGatewayGrants(client);

// Idempotent boot seeding: dev org/user/member only. No demo content — the
// Knowledge and Skills surfaces start empty and fill with real records.
await seedDev();

// Fleet boot reconciliation (HA Stage A): the process that held every active
// sandbox lease is gone, so release them all (capacity zeroed) and unbind
// non-terminal admissions BEFORE recovery re-pumps threads — so a re-dispatched
// run mints a fresh lease and the queue never double-counts a dead reservation.
const fleetBoot = await reconcileFleetOnBoot();
if (
  fleetBoot.releasedLeases > 0 ||
  fleetBoot.resetAdmissions > 0 ||
  fleetBoot.syncedTerminal > 0
) {
  console.log(
    `[boot] fleet recovery — ${fleetBoot.releasedLeases} leases released, ` +
      `${fleetBoot.resetAdmissions} admissions re-queued, ` +
      `${fleetBoot.syncedTerminal} synced terminal`,
  );
}

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

// Learning-outbox boot recovery: a crash mid-build strands a `processing` row.
// Reset it to `pending` so the worker retries — SAFE because candidate building
// is idempotent (one draft per run).
const learningReset = await resetStuckLearning();
if (learningReset > 0)
  console.log(`[boot] learning recovery — ${learningReset} stuck rows re-armed`);

const app = new Hono<AppEnv>();

// CORS for the frontend, with credentials so cookie sessions flow when the
// browser calls the backend directly (the Next dev proxy is same-origin).
app.use(
  "/api/*",
  cors({
    origin: env.FRONTEND_ORIGIN,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "x-skynet-client-release"],
    exposeHeaders: ["x-skynet-release-fingerprint", "x-skynet-api-compat"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.use("/api/*", async (c, next) => {
  const release = currentReleaseFingerprint();
  c.header("x-skynet-release-fingerprint", release.fingerprint);
  c.header("x-skynet-api-compat", release.apiCompat);
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) &&
    !isClientReleaseCompatible(c.req.header("x-skynet-client-release"), release.fingerprint)
  ) {
    return c.json(
      {
        error: "frontend_release_mismatch",
        release,
      },
      409,
    );
  }
  return next();
});

// API-key bearer lane (fail CLOSED), BEFORE session/public resolution. A request
// carrying `Authorization: Bearer uak_...` is authenticated against a stored hash
// and gated by a deny-by-default route allowlist (middleware/bearer.ts): a valid
// key reaches only run dispatch + read paths, an unknown/revoked key or an
// off-allowlist route is 401. A request WITHOUT such a header passes straight
// through untouched, so cookie sessions and the self-authenticating internal
// bearer routes below are unaffected.
app.use("/api/*", bearerAuth);

// Universal auth adapter (fail CLOSED by default). Every /api/* request is
// org-session scoped UNLESS its prefix self-authenticates or is public
// (isPublicApiPath). A NEW router therefore needs no auth wiring to be
// protected - forgetting `.use(orgScope)` no longer leaves it open, it just
// runs behind the adapter. orgScope is idempotent (a bearer-resolved org is a
// no-op here), so the per-router guards that remain are free defense-in-depth.
// This runs before every mounted route below.
app.use("/api/*", async (c, next) => {
  if (isPublicApiPath(c.req.path)) return next();
  return orgScope(c, next);
});

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.route("/api/internal/artifact-changes", internalArtifactChangeRoutes);
app.route("/api/internal/automation", internalAutomationRoutes);
app.route("/api/internal/gateway-approval/consume", internalGatewayApprovalRoutes);
app.route("/api/internal/gateway-approval-requests", internalApprovalRequestRoutes);
app.route("/api/internal/codex-relay", codexSubscriptionRelayRoutes);
// Loopback-only operator dispatch bridge (see runs/operator-routes.ts): lets
// the release-lane parity canary run turns IN THIS PROCESS so the codex relay
// rendezvous works. Secret-authenticated; proxied requests are rejected.
app.route(
  "/api/internal/operator",
  createOperatorRoutes({
    pump: pumpThread,
    cancel: signalCancel,
    approveGatewayRequest: approveApprovalRequestAsRunOwner,
    admitReleaseParity: (c, body) =>
      handleRunCreate(c, { body, origin: "internal:eval" }),
  }),
);

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
    release: currentReleaseFingerprint(),
    engines,
    models,
    sandbox: { provider: sandboxProviderKind() },
    capabilities: {
      github: githubConfigured(),
      slack: slackConfig() !== null,
      memory: memoryConfig() !== null,
      toolGateway: toolGatewayConfig() !== null,
    },
    // Honest per-format editing fidelity, from the shared artifact-workspace
    // source of truth so the API and the UI never disagree about what a
    // canonical companion actually preserves (or that uploaded PDF import is off).
    artifacts: { fidelity: ARTIFACT_FIDELITY },
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
app.route("/api/dashboard", dashboardRoutes);
// multi-repo skill import from the org's GitHub repos (scan + import). Mounted
// before /api/skills so the /import subtree resolves to its own routes.
app.route("/api/skills/import", skillImportRoutes);
// Learning lane (item 6): human-gated skill revision proposals. Mounted before
// /api/skills so the /proposals subtree resolves to its own routes.
app.route("/api/skills/proposals", skillProposalRoutes);
app.route("/api/skills", skillsRoutes);
app.route("/api/automations", schedulesRoutes);
// Backward-compatible alias for sessions and frontend bundles created before
// the product surface was renamed to Automations.
app.route("/api/schedules", schedulesRoutes);
// Org Secrets — encrypted named secrets injected as env vars into the per-thread
// sandbox at boot. Org-scoped; values are write-only at this boundary (set/delete
// only, never returned). See src/secrets/*.
app.route("/api/secrets", secretsRoutes);
// Org API keys - long-lived bearer credentials for local-to-cloud run dispatch.
// SESSION AUTH ONLY (a bearer key cannot mint or revoke keys); the plaintext
// secret is shown once at creation and only its hash is stored. See
// src/api-keys/* and the bearer lane in src/middleware/bearer.ts.
app.route("/api/api-keys", apiKeysRoutes);
// User-scoped provider credentials. Values are encrypted at rest and write-only
// over HTTP; trusted backend consumers use src/provider-connections/service.ts.
app.route("/api/provider-connections", providerConnectionsRoutes);
// Tenant-owned SaaS connections. Native GitHub/Slack remain managed adapters;
// optional long-tail backends stay behind the provider-neutral lifecycle.
app.route("/api/integrations", integrationRoutes);
// Learning lane (item 4): reviewable knowledge drafts from high-value runs.
// Mounted before /api/knowledge so the /drafts subtree resolves to its own routes.
app.route("/api/knowledge/drafts", knowledgeDraftRoutes);
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

// Periodic GitHub skill resync — keeps the org's .claude/skills SKILL.md files
// flowing into the catalog without manual per-repo imports. OFF by default:
// only when SKILLS_RESYNC_INTERVAL_MIN is set does it sweep (serial, paced,
// bounded), reusing the manual import's source-keyed idempotent upsert.
startSkillsResync();

// Periodic repository CODE indexer - projects org-approved repos' docs, config,
// domains, symbols, and manifests into context_index as kind="code" so terms that
// live only in code (e.g. `yofix`) become searchable evidence. OFF by default:
// only when CODE_INDEX_INTERVAL_MIN is set does it sweep (serial, paced, bounded,
// unchanged-HEAD short-circuit so a restart never full-rescans).
startCodeIndex();

// Memory capture-outbox delivery loop (15s tick). Delivers each completed run's
// queued outcome to team memory with retry/backoff/dead-letter; harmless when
// memory is disabled (deliverTeamMemory no-ops). AT-MOST-once (crash-orphaned
// `delivering` rows await manual inspection, never auto-retried).
startCaptureDelivery();

// Canonical-lane outbox delivery loop (1s tick). Drains
// each settled run's enqueued canonicalization: translates the native source to
// canonical events with a source-watermark stability check, replaces provisional
// rows, and marks `complete` only when the whole source was translated. Harmless
// when nothing is due; multi-instance safe (FOR UPDATE SKIP LOCKED claim).
startCanonicalizationOutbox();

// Learning-outbox delivery loop (15s tick, self_improving 6.1). Builds each
// completed non-internal run's evidence-backed learning candidate off the intent
// enqueued IN the finalization transaction — retry/backoff/dead-letter, and it
// never fails an already-completed run. The verified-outcome gate (6.4) runs at
// build time, so an unverified completion is a clean skip, not a candidate.
startLearningOutbox();

// Adaptive post-boot reconciler (#63, 15s tick). Re-probes runs PARKED by boot
// recovery (native session may still be finishing after a fast restart): adopts
// the finished session, honest-fails after the ~5min budget. Single-flight;
// harmless when nothing is parked.
startReconcileLoop();

// Fleet capacity reconciler (HA Stage A, 5s tick). Heartbeats live leases,
// reclaims + provider-GCs expired ones (crashed workers), and admits durably-
// queued work as capacity frees. Single-flight with a watchdog; DB-backed so it
// survives restarts. The durable queue + leases make "accepted" mean "persisted
// as queued", not "started instantly". FLEET_RECONCILER_AUTOSTART=0 disables the
// background loop (the unit suite drives admission explicitly).
if (process.env.FLEET_RECONCILER_AUTOSTART !== "0") startFleetReconciler();

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

const cubeRuntimePoolTarget = cubeRuntimeWarmPoolSize();
const cubeRuntimeTemplate = operatorEnv(
  process.env,
  "RUNTIME_CUBE_TEMPLATE_ID",
  "T3_CUBE_TEMPLATE_ID",
)?.trim();
if (sandboxProviderKind() === "cube" && cubeRuntimePoolTarget && cubeRuntimeTemplate) {
  const apiKey = sandboxProviderApiKey();
  const autoStopInterval = Number(process.env.SANDBOX_AUTO_STOP_MIN ?? 30);
  const autoDeleteInterval = Number(process.env.SANDBOX_AUTO_DELETE_MIN ?? 4320);
  startCubeWarmPool({
    name: RUNTIME_CUBE_WARM_POOL_NAME,
    provider: sandboxProvider(apiKey),
    size: cubeRuntimePoolTarget,
    requireDesktop: false,
    createOptions: {
      snapshot: cubeRuntimeTemplate,
      labels: {
        ...providerGatewaySandboxLabels(`warm-pool:${RUNTIME_GENERATION}`),
        [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION,
      },
      autoStopInterval,
      autoDeleteInterval,
    },
    warmRuntime: async (sandbox, signal) => {
      const runtimePrewarmEnv = { ...process.env, RUNTIME_ENVIRONMENT_ENABLED: "true" };
      await prewarmRuntimeProviderBridge(sandbox, runtimePrewarmEnv);
      await Promise.all([
        prewarmRuntimeEnvironmentAccess(sandbox, signal),
        prewarmOpenCodeRuntime(sandbox, signal),
      ]);
    },
  });
  console.log(
    `[cube-warm-pool:${RUNTIME_CUBE_WARM_POOL_NAME}] target=${cubeRuntimePoolTarget} template=${cubeRuntimeTemplate}`,
  );
}

// Slack adapter: mounted when the shared App signing secret is configured.
// Workspace bot tokens resolve from encrypted OAuth connections; a global bot
// token is a named single-workspace legacy fallback only. Handles the Events
// API at POST /api/slack/events, and starts
// the durable outbox relay (boot recovery of undelivered replies + retry loop).
// Workspace -> org/user bindings from SLACK_WORKSPACE_BINDINGS are upserted here
// (ingress fails closed for workspaces with no mapping).
if (slackEnabled()) {
  app.route("/api/slack", slackRoutes);
  await syncSlackWorkspaceBindings();
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
