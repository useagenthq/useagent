import { Hono } from "hono";
import { websocket } from "hono/bun";
import { cors } from "hono/cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { auth } from "./auth";
import { startEmailConnector } from "./connectors/email";
import { db } from "./db/client";
import {
  allowDevOrg,
  connectorEmailConfig,
  env,
  githubConfigured,
  googleAuthEnabled,
  memoryConfig,
  slackConfig,
} from "./env";
import { toolGatewayConfig } from "./knowledge/gateway/config";
import { knowledgeRoutes } from "./knowledge/routes";
import { knowledgeMcpRoutes } from "./knowledge/gateway/mcp";
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
import { seedDev } from "./seed";
import { skillImportRoutes } from "./skills/import-routes";
import { skillsRoutes } from "./skills/routes";
import { slackEnabled, slackRoutes, startSlackOutbox } from "./slack";
import { wikiGenRoutes } from "./wiki-gen/routes";

// Apply committed Drizzle migrations BEFORE anything reads or seeds the schema,
// so a fresh clone (or a fresh database) boots with the tables in place. The
// migrator is idempotent — already-applied migrations are skipped. Path is
// resolved from this module so cwd doesn't matter.
await migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });

// Idempotent boot seeding: dev org/user/member only. No demo content — the
// Knowledge and Skills surfaces start empty and fill with real records.
await seedDev();

// Recover orphaned runs from a previous (unclean) shutdown: reconcile the ones
// whose native opencode session actually finished server-side, fail the rest
// with an honest resumable summary. One-shot, self-bounded — never hangs boot.
const recovery = await recoverStaleRuns();
if (recovery.reconciled > 0 || recovery.failed > 0 || recovery.redispatched > 0 || recovery.parked > 0) {
  console.log(
    `[boot] command-lane recovery — ${recovery.reconciled} reconciled, ` +
      `${recovery.failed} failed, ${recovery.redispatched} re-dispatched, ` +
      `${recovery.parked} parked for re-probe`,
  );
}

const app = new Hono();

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

app.get("/api/health", (c) => c.json({ status: "ok" }));

// Public client config — what the frontend needs to render auth affordances
// (which social providers are enabled) without exposing any secret. `allowDevOrg`
// lets the UI reflect that unauthenticated dev access is currently open.
// `capabilities` are honest config-gated booleans (a name is NOT a secret) so
// surfaces like /agent/plugins can show what is actually wired vs not.
app.get("/api/config", (c) =>
  c.json({
    auth: { google: googleAuthEnabled(), emailPassword: true },
    allowDevOrg: allowDevOrg(),
    capabilities: {
      github: githubConfigured(),
      slack: slackConfig() !== null,
      memory: memoryConfig() !== null,
      toolGateway: toolGatewayConfig() !== null,
    },
  }),
);

// better-auth: email/password + organization plugin, mounted at /api/auth/*.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/api/runs", runsRoutes);
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
app.route("/api/schedules", schedulesRoutes);
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
// Trusted knowledge MCP gateway (mem_op.md 0.2). Token-authed, NOT session/org
// scoped — the resident opencode agent in an untrusted sandbox reaches it with a
// short-lived run-scoped bearer token, and identity is derived from that token
// alone (see gateway/mcp.ts). Mounted always; inert without a valid token.
app.route("/api/mcp/knowledge", knowledgeMcpRoutes);
// Snapshot-level slash-command catalog (cached from the live-proxy's /command
// taps) — powers "/" autocomplete on the New Task composer before a sandbox
// exists.
app.route("/api/commands", commandsRoutes);

// Always-on scheduler loop (60s tick). Harmless when no schedule is enabled —
// schedules default disabled, so nothing auto-fires until a human turns it on.
startScheduler();

// Memory capture-outbox delivery loop (15s tick). Delivers each completed run's
// queued outcome to team memory with retry/backoff/dead-letter; harmless when
// memory is disabled (deliverTeamMemory no-ops). AT-MOST-once (crash-orphaned
// `delivering` rows await manual inspection, never auto-retried).
startCaptureDelivery();

// Adaptive post-boot reconciler (#63, 15s tick). Re-probes runs PARKED by boot
// recovery (native session may still be finishing after a fast restart): adopts
// the finished session, honest-fails after the ~5min budget. Single-flight;
// harmless when nothing is parked.
startReconcileLoop();

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
