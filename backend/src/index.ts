import { Hono } from "hono";
import { websocket } from "hono/bun";
import { cors } from "hono/cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ARTIFACT_FIDELITY } from "@useagent/artifact-workspace";
import { handleAuthRequest } from "./auth/routes";
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
  memoryConfig,
  primaryOrgId,
  slackConfig,
} from "./env";
import { isPublicApiPath, orgScope } from "./middleware/org";
import { bearerAuth } from "./middleware/bearer";
import { chatRoutes } from "./chat/routes";
import { labRoutes } from "./lab/routes";
import { botsRoutes } from "./bots/routes";
import { toolGatewayConfig } from "./knowledge/gateway/config";
import { knowledgeRoutes } from "./knowledge/routes";
import { knowledgeDraftRoutes, skillProposalRoutes } from "./learning/routes";
import { memoryRoutes } from "./memory/routes";
import { commandsRoutes } from "./runs/command-catalog";
import { createOperatorRoutes } from "./runs/operator-routes";
import { reposRoutes } from "./github/routes";
import { pullsRoutes } from "./github/pulls-routes";
import { desktopProxyRoutes } from "./runs/desktop-proxy";
import { parsePreviewViewPath } from "./runs/preview-capability";
import { fleetRoutes } from "./runs/fleet-routes";
import { spendRoutes } from "./runs/spend-routes";
import { spendAllowanceDefaultUsd } from "./runs/spend";
import { sandboxMinutesRoutes } from "./runs/sandbox-minutes-routes";
import { sandboxPreferenceRoutes } from "./sandboxes/preference-routes";
import { portProxyRoutes } from "./runs/port-proxy";
import { recoverStaleRuns, startReconcileLoop } from "./runs/recovery";
import {
  reconcileFleetOnBoot,
  startFleetReconciler,
} from "./fleet/reconciler";
import { pumpThread, signalCancel } from "./worker";
import { handleRunCreate, runsRoutes } from "./runs/routes";
import { registerRunResendRoute } from "./runs/resend-route";
import { terminalRoutes } from "./runs/terminal";
import { runFeedbackRoutes } from "./runs/feedback-routes";
import { runnerLinkRoutes, runnerRegistryProxyRoutes } from "./runners/link";
import { runnerBridgeRoutes } from "./runners/bridge";
import { runnerRoutes } from "./runners/routes";
import { teamRoutes } from "./team/routes";
import { runnerConfigBlock } from "./runners/policy";
import { runnerRegistry } from "./runners/registry";
import { schedulesRoutes } from "./schedules/routes";
import { startScheduler } from "./schedules/scheduler";
import { startCaptureDelivery } from "./memory/capture-outbox";
import { resetStuckLearning, startLearningOutbox } from "./learning/learning-outbox";
import { sandboxProvider, sandboxProviderApiKey, sandboxProviderKind } from "./sandboxes/provider";
import { userComputersEnabled } from "./sandboxes/binding";
import { operatorRoutes } from "./operator/routes";
import { botsEnabled } from "./bots/rollout";
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
import { tasksRoutes } from "./tasks/routes";
import { projectsRoutes } from "./projects/routes";
import { slackEnabled, slackRoutes, startSlackOutbox, syncSlackWorkspaceBindings } from "./slack";
import { enforceSingleBackend } from "./db/single-backend";
import {
  cubeRuntimeWarmPoolSize,
  startCubeWarmPool,
} from "./sandboxes/cube-warm-pool";
import { providerGatewaySandboxLabels } from "./provider-gateway/sandbox-config";
import {
  RUNTIME_CUBE_WARM_POOL_NAME,
  RUNTIME_GENERATION,
  RUNTIME_GENERATION_LABEL,
} from "./engines/runtime-environment";
import { prewarmRuntimeEnvironmentAccess } from "./engines/runtime-environment-client";
import { operatorEnv } from "./engines/runtime-env";
import { prewarmRuntimeProviderBridge } from "./engines/runtime-provider-bridge";
import { prewarmCodexServices } from "./engines/codex-subscription-runtime";
import { engineAuthMode } from "./runs/engine-auth-mode";
import { providerConnectionsRoutes } from "./provider-connections/routes";
import { integrationRoutes } from "./integrations/routes";
import { codexSubscriptionRelayRoutes } from "./provider-connections/codex-subscription-relay";
import { wikiGenRoutes } from "./wiki-gen/routes";
import { cleanupRepositoryScratch } from "./wiki-gen/clone";
import { startFreeModelLanePruner } from "./runs/free-model-lane-prune";
import {
  configuredEngineReadiness,
  configuredUserFacingEngines,
  engineModelsForConfiguredEngines,
  engineModelsForReadyEngines,
  readyUserFacingEngines,
} from "./runs/engine-readiness";
import { freeModelLane, freeModelLaneCache } from "./runs/free-model-lane";
import {
  freeModelQualifierEnabled,
  hydrateFreeModelLaneFromRegistry,
  QUALIFIER_ADMISSION_WAIT_MS,
  respondToManualRefresh,
  startFreeModelQualifierWorker,
  startFreeModelRegistryHydrator,
  type FreeModelQualifier,
} from "./runs/free-model-qualifier-worker";
import {
  createInternalOpenCodeQualificationDriver,
} from "./runs/free-model-qualification-driver";
import { acceptInternalRunCommand } from "./commands/service";
import { latestProviderGatewayOutcome } from "./provider-gateway/audit";
import { resolveProviderCredential } from "./provider-gateway/credentials";
import { acceptRunCancel } from "./commands/cancel";
import {
  deploymentInflightSnapshot,
  getRunAdmission,
  getRunAdmissionWithin,
  setRunAdmission,
} from "./commands/admission";
import { getRunWithSteps } from "./runs/repo";
import { resolveSession } from "./auth/session";
import { deploymentProvidedProviders } from "./provider-gateway/provider";
import { catalogAccount, modelOfferedTo, providersOfferedTo, restrictedProviders } from "./provider-gateway/provider-accounts";
import { uploadRoutes } from "./uploads/routes";
import { startUploadCleanup } from "./uploads/cleanup";
import { internalAutomationRoutes } from "./schedules/internal-routes";
import { internalChildSessionRoutes } from "./knowledge/gateway/child-session-internal-routes";
import {
  gatewayApprovalRoutes,
  internalGatewayApprovalRoutes,
} from "./knowledge/gateway/approval-routes";
import { internalApprovalRequestRoutes } from "./knowledge/gateway/approval-request-tools";
import { internalGithubRoutes } from "./knowledge/gateway/github-internal-routes";
import { approveApprovalRequestAsRunOwner } from "./knowledge/gateway/approval-requests";
import { currentReleaseFingerprint, isClientReleaseCompatible } from "./release";
import { dashboardRoutes } from "./dashboard/routes";
import { fleetBatchRoutes } from "./fleet/batch-routes";
import { ensureCanonicalExecutionTranscriptIndexForBoot } from "./db/online-indexes/canonical-execution-transcript";
import { capabilityCatalogRoutes } from "./capabilities/routes";
import { threadRelationshipRoutes } from "./runs/thread-relationship-routes";
import { configureProductChildPump } from "./runs/child-session-pump";
import { assertThreadRelationshipConfig, productChildThreadsEnabled, threadRelationshipsEnabled } from "./runs/thread-relationship-switch";
import { repairEligiblePublicRootThreadRelationships } from "./runs/thread-relationship-repo";
import { artifactStorageHealth, assertArtifactStorageWritable } from "./artifacts/storage";
import { installProcessFaultHandlers } from "./process-faults";

// Acquire the per-database singleton before ANY shared-state mutation. In strict
// production mode an unavailable/contended lock fails boot closed, so a duplicate
// process cannot migrate or recover another backend's database first.
// Only as the process entry: suites import this module in-process and keep bun test's own reporting.
if (import.meta.main) installProcessFaultHandlers();
assertThreadRelationshipConfig();
const singleBackendHeld = await enforceSingleBackend();
// Artifact bytes must be writable before any run can publish; a missing mount
// fails boot here rather than surfacing as EROFS inside a run.
await assertArtifactStorageWritable();

// A process crash can strand temporary private checkouts on the disk-backed
// scratch mount. With the single-backend lock held, no live clone belongs to
// another backend, so startup can safely remove only our exact temp prefixes.
if (singleBackendHeld) {
  const scratchCleanup = await cleanupRepositoryScratch();
  if (scratchCleanup.removed > 0) {
    console.log(`[boot] repository scratch cleanup — ${scratchCleanup.removed} stale directories removed`);
  }
  for (const failure of scratchCleanup.failures) {
    console.error(`[boot] repository scratch cleanup failed: ${failure}`);
  }
}

// Apply committed Drizzle migrations BEFORE anything reads or seeds the schema,
// so a fresh clone (or a fresh database) boots with the tables in place. The
// migrator is idempotent — already-applied migrations are skipped. Path is
// resolved from this module so cwd doesn't matter.
await migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });
if (threadRelationshipsEnabled()) {
  await repairEligiblePublicRootThreadRelationships();
}

// READ serves child transcripts from the canonical execution identity lookup.
// The large online index is managed separately from transactional migrations;
// fail boot closed in READ rather than silently serving an unindexed scan.
await ensureCanonicalExecutionTranscriptIndexForBoot();

// Hydrate the synchronous model-policy cache from the last published Free-lane
// generation before serving config; the hydrator then follows it every minute.
await hydrateFreeModelLaneFromRegistry();
startFreeModelRegistryHydrator();
// Drop Free-lane models OpenRouter stopped serving, hourly, with or without the qualifier.
startFreeModelLanePruner();
configureProductChildPump(pumpThread);

// Reconcile the restricted gateway role's grants on EVERY boot: a migration
// that adds a gateway-written table ships its grant in the same commit (see
// db/gateway-grants.ts for the incident class this kills).
// Knowledge owns three lazily-created tables outside Drizzle. The privileged
// backend must create them before a present restricted role receives grants;
// otherwise the first boot permanently skips that capability.
const { ready: prepareKnowledgeSchema } = await import("./knowledge/store");
await prepareKnowledgeSchema();
const { applyGatewayGrants } = await import("./db/gateway-grants");
await applyGatewayGrants(client, { strict: process.env.NODE_ENV === "production" });

// Idempotent boot seeding: dev org/user/member only. No demo content — the
// Knowledge and Skills surfaces start empty and fill with real records.
await seedDev();

// Fleet boot reconciliation (HA Stage A): the process that held every active
// sandbox lease is gone, so release them all (capacity zeroed) and unbind
// non-terminal admissions BEFORE recovery re-pumps threads — so a re-dispatched
// run mints a fresh lease and the queue never double-counts a dead reservation.
const fleetBoot = await reconcileFleetOnBoot();
// Enrolled machines are known from boot (offline until they say hello) so a
// recorded local sandbox resolves to its runner; the sweeper retires links
// whose heartbeats stopped.
const knownRunners = await runnerRegistry.load();
if (knownRunners > 0) console.log(`[boot] ${knownRunners} enrolled runner${knownRunners === 1 ? "" : "s"} known`);
runnerRegistry.startSweeper();
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
// browser calls the backend directly (the Next dev proxy is same-origin). A
// sandbox preview view answers its opaque-origin page itself (preview-capability.ts).
const frontendCors = cors({
  origin: env.FRONTEND_ORIGIN,
  credentials: true,
  allowHeaders: ["Content-Type", "Authorization", "x-useagent-client-release"],
  exposeHeaders: ["x-useagent-release-fingerprint", "x-useagent-api-compat"],
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
});
app.use("/api/*", (c, next) => (parsePreviewViewPath(c.req.path) ? next() : frontendCors(c, next)));

app.use("/api/*", async (c, next) => {
  const release = currentReleaseFingerprint();
  c.header("x-useagent-release-fingerprint", release.fingerprint);
  c.header("x-useagent-api-compat", release.apiCompat);
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) &&
    !isClientReleaseCompatible(c.req.header("x-useagent-client-release"), release.fingerprint)
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

app.get("/api/health", async (c) => {
  const storage = await artifactStorageHealth();
  if (!storage.ok) return c.json({ status: "unhealthy", artifact_storage: storage.error }, 503);
  return c.json({ status: "ok" });
});
app.route("/api/internal/artifact-changes", internalArtifactChangeRoutes);
app.route("/api/internal/automation", internalAutomationRoutes);
app.route("/api/internal/child-sessions", internalChildSessionRoutes);
app.route("/api/internal/gateway-approval/consume", internalGatewayApprovalRoutes);
app.route("/api/internal/gateway-approval-requests", internalApprovalRequestRoutes);
app.route("/api/internal/github-operations", internalGithubRoutes);
app.route("/api/internal/codex-relay", codexSubscriptionRelayRoutes);
// A developer's machine as a sandbox provider: the runner's outbound link
// (runner-token authenticated, see runners/link.ts) and the org-scoped
// enrolment, listing and policy routes.
app.route("/api/internal/runners", runnerLinkRoutes);
app.route("/api/internal/runners", runnerBridgeRoutes);
app.route("/api/runners", runnerRoutes);
app.route("/api/team", teamRoutes);
// The sandbox image, served to runners under the standard registry API.
app.route("/", runnerRegistryProxyRoutes);
app.route("/api/threads", threadRelationshipRoutes);
// Loopback-only operator dispatch bridge (see runs/operator-routes.ts): lets
// the release-lane parity canary run turns IN THIS PROCESS so the codex relay
// rendezvous works. Secret-authenticated; proxied requests are rejected.
app.route(
  "/api/internal/operator",
  createOperatorRoutes({
    getAdmission: getRunAdmission,
    setAdmission: setRunAdmission,
    deploymentInflight: deploymentInflightSnapshot,
    pump: pumpThread,
    cancel: signalCancel,
    approveGatewayRequest: approveApprovalRequestAsRunOwner,
    admitReleaseParity: (c, body, expectedSandbox) =>
      handleRunCreate(c, { body, origin: "internal:eval", expectedSandbox }),
  }),
);

// Public client config — what the frontend needs to render auth affordances
// (which social providers are enabled) without exposing any secret. `allowDevOrg`
// lets the UI reflect that unauthenticated dev access is currently open.
// `capabilities` are honest config-gated booleans (a name is NOT a secret) so
// surfaces like /agent/plugins can show what is actually wired vs not.
app.get("/api/config", async (c) => {
  // Configured engines stay discoverable even while a provider needs attention;
  // the additive readiness map explains why without weakening the fail-closed
  // POST /api/runs dispatch gate. mock/daytona/claude-sdk remain internal aliases.
  const engines = readyUserFacingEngines();
  const configuredEngines = configuredUserFacingEngines();
  const engineReadiness = configuredEngineReadiness();
  // This route is public, so the reader is whoever the session says, or nobody:
  // a provider PROVIDER_ACCOUNTS restricts shows only to the accounts it lists.
  const account = restrictedProviders().size > 0
    ? (await resolveSession(c.req.raw.headers).catch(() => null))?.user.email ?? null
    : null;
  const offered = new Set<string>(providersOfferedTo(account));
  const models = engineModelsForReadyEngines(process.env, account);
  const configuredModels = engineModelsForConfiguredEngines(process.env, account);
  return c.json({
    auth: "better-auth",
    allowDevOrg: allowDevOrg(),
    release: currentReleaseFingerprint(),
    engines,
    configuredEngines,
    engineReadiness,
    models,
    configuredModels,
    // Which vendor the sandboxes come from is the operator's business and is
    // served by /api/operator/sandbox; everyone else reads "Cloud".
    sandbox: { userComputers: userComputersEnabled() },
    // What a runner must speak and boot to lend this deployment a machine.
    runner: runnerConfigBlock(),
    // Per model provider this reader is offered: served from this deployment's own key (a name, never a value).
    providers: Object.fromEntries(Object.entries(deploymentProvidedProviders()).filter(([provider]) => offered.has(provider))),
    offeredProviders: [...offered],
    // The product tool families a gateway process advertises follow this
    // answer, so a gateway booted with different flags cannot silently drop
    // child-session or bot-handoff tools (knowledge/gateway/product-flags).
    product: { childThreads: productChildThreadsEnabled(), bots: botsEnabled(null) },
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

// Manual Free-lane refresh (the picker's "Refresh free models" affordance).
// Org-session authed by the universal adapter (NOT in the public allowlist).
// Runs a qualifier tick now: the catalog is discovered before this responds
// (bounded: a tick held behind the admission lock answers 202 pending), the
// probe runs it queues finish in the background and publish on their own. A
// process-global cool-down protects OpenRouter and the probe budget (the lane
// is deployment-wide, so one refresh serves every org). Always returns the
// current manifest so the picker can swap its list in place.
let freeModelQualifier: FreeModelQualifier | null = null;
app.post("/api/config/models/refresh", async (c) => {
  const response = await respondToManualRefresh(freeModelQualifier);
  const account = await catalogAccount(c.get("userId"));
  return c.json({
    ...response.body,
    free: freeModelLane().filter((model) => modelOfferedTo("opencode", model, account)),
    models: engineModelsForReadyEngines(process.env, account),
    configuredModels: engineModelsForConfiguredEngines(process.env, account),
  }, response.status);
});

// Better Auth owns login, sessions, and organization membership.
app.on(["GET", "POST"], "/api/auth/*", (c) => handleAuthRequest(c.req.raw, c.env));

// Lightweight Chat (#122): a NO-SANDBOX conversational surface at /. Streams a
// model completion directly (OpenRouter), augmented with read-only retrieval
// (org knowledge + published wiki + team memory). Org-scoped; inert without
// OPENROUTER_API_KEY (503). Distinct from /api/runs (which spins sandboxes).
app.route("/api/chat", chatRoutes);
app.route("/api/lab", labRoutes);
app.route("/api/operator", operatorRoutes);

registerRunResendRoute(runsRoutes); // Lives outside runs/routes.ts, which is at its size cap.
app.route("/api/runs", runsRoutes);
app.route("/api/spend", spendRoutes);
spendAllowanceDefaultUsd(); // boot-time validation of SPEND_ALLOWANCE_USD against the ledger ceiling (logged once)
app.route("/api/sandbox-minutes", sandboxMinutesRoutes);
app.route("/api/sandbox-preference", sandboxPreferenceRoutes);
app.route("/api/capabilities", capabilityCatalogRoutes);
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
// In-app feedback on a run: stored, then a Slack notice through the outbox.
app.route("/api/runs", runFeedbackRoutes);
// Same-origin bridge to a thread's opencode server for the embedded "Live" tab
// (frontend/public/opencode-app). Injects the Daytona preview token, streams
// SSE through untouched.
// Same-origin bridge to a thread's noVNC desktop for the "Desktop" tab — proxies
// noVNC's static app over HTTP and its RFB WebSocket, injecting the Daytona
// preview token on both (shares the `websocket` handler above).
app.route("/api/desktop-proxy", desktopProxyRoutes);
app.route("/api/port-proxy", portProxyRoutes);
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
app.route("/api/fleet/batches", fleetBatchRoutes);
app.route("/api/dashboard", dashboardRoutes);
// skill import from the org's GitHub repos (scan + import). Mounted
// before /api/skills so the /import subtree resolves to its own routes.
app.route("/api/skills/import", skillImportRoutes);
// Learning lane (item 6): human-gated skill revision proposals. Mounted before
// /api/skills so the /proposals subtree resolves to its own routes.
app.route("/api/skills/proposals", skillProposalRoutes);
app.route("/api/skills", skillsRoutes);
// Native task manager - durable, org-scoped tasks grouped per project (repo
// full_name or free label) and rendered as a Kanban board. Agents create/update
// tasks mid-run through the knowledge gateway; they outlive the run.
app.route("/api/tasks", tasksRoutes);
app.route("/api/projects", projectsRoutes);
app.route("/api/automations", schedulesRoutes);
// Backward-compatible alias for sessions and frontend bundles created before
// the product surface was renamed to Automations.
app.route("/api/schedules", schedulesRoutes);
app.route("/api/bots", botsRoutes);
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
// Slash-command catalog for the pre-session picker: the latest catalog a native
// session of this org advertised for the chosen engine, read from the durable
// canonical stream. Powers "/" autocomplete on the New Task composer.
app.route("/api/commands", commandsRoutes);

// Always-on scheduler loop (60s tick). Harmless when no schedule is enabled —
// Automations default disabled, so nothing auto-fires until a human turns it on.
startScheduler();

// Durable full-agent Free-model qualification: on by default, FREE_MODEL_QUALIFIER=off
// is the kill switch. Discovery runs every tick; probe runs need an organization
// to own them (FREE_MODEL_QUALIFIER_ORG_ID, else the deployment's primary
// organization) and are low priority. Admission is checked every tick and
// before every probe, so deployment drain/close cannot start qualification traffic.
if (freeModelQualifierEnabled()) {
  const qualifierOrgId = process.env.FREE_MODEL_QUALIFIER_ORG_ID?.trim() || primaryOrgId();
  if (!qualifierOrgId) {
    console.warn(
      "[free-model-qualifier] no organization owns qualification runs (set USEAGENT_PRIMARY_ORG_ID); discovery only",
    );
  }
  const driver = qualifierOrgId
    ? createInternalOpenCodeQualificationDriver(
        { orgId: qualifierOrgId },
        {
          accept: acceptInternalRunCommand,
          pump: pumpThread,
          read: getRunWithSteps,
          cancel: async (orgId, runId) => {
            const outcome = await acceptRunCancel({ orgId, actorId: null, runId });
            if (outcome.status === "accepted" || outcome.status === "already") {
              signalCancel(runId, "Model qualification timed out");
              await pumpThread(outcome.threadId);
            }
          },
          admission: () => getRunAdmissionWithin(QUALIFIER_ADMISSION_WAIT_MS),
          lastUpstream: latestProviderGatewayOutcome,
        },
      )
    : null;
  freeModelQualifier = startFreeModelQualifierWorker({
    driver,
    // Probe runs spend the probe organization's own stored OpenRouter key, never
    // the deployment's; without one the lane discovers but does not probe.
    probeCredential: qualifierOrgId
      ? async () => (await resolveProviderCredential(qualifierOrgId, "openrouter")) !== null
      : undefined,
    adoptPublishedLane: (state) => freeModelLaneCache.adoptRegistryLane(state.currentModelIds),
  });
}

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
      await prewarmRuntimeEnvironmentAccess(sandbox, signal);
      // A new thread's first subscription Codex turn finds its services up; a
      // failure here only leaves them to that turn, as without the pool.
      if (engineAuthMode("codex") !== "provider_gateway") {
        await prewarmCodexServices(sandbox).catch((error: unknown) => {
          console.warn(`[cube-warm-pool:${RUNTIME_CUBE_WARM_POOL_NAME}] Codex services not pre-warmed`, error);
        });
      }
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

console.log(`[useagent] backend listening on http://localhost:${env.PORT}`);

export default {
  hostname: process.env.USEAGENT_BIND_HOST ?? "127.0.0.1",
  port: env.PORT,
  fetch: app.fetch,
  // Bun WebSocket handler for the terminal bridge (hono/bun upgradeWebSocket).
  websocket,
  // Long-held requests are legitimate here: the Live tab's prompt POST stays
  // open for a whole engine turn on the thread stream. Bun's 10s default
  // idle timeout kills them ("Failed to fetch" in opencode's composer); 255s
  // is Bun's maximum. Turns longer than that keep running server-side — only
  // the embed's request errors.
  idleTimeout: 255,
  // Keep the absolute socket-level ceiling just above the 25 MB upload limit;
  // JSON-heavy routes enforce much smaller per-route bounds before parsing.
  maxRequestBodySize: 32 * 1024 * 1024,
};
