import { Hono } from "hono";
import { cors } from "hono/cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { auth } from "./auth";
import { startEmailConnector } from "./connectors/email";
import { db } from "./db/client";
import { connectorEmailConfig, env } from "./env";
import { knowledgeRoutes } from "./knowledge/routes";
import { failStaleRuns } from "./runs/repo";
import { runsRoutes } from "./runs/routes";
import { schedulesRoutes } from "./schedules/routes";
import { startScheduler } from "./schedules/scheduler";
import { seedDev } from "./seed";
import { skillsRoutes } from "./skills/routes";
import { slackEnabled, slackRoutes } from "./slack";

// Apply committed Drizzle migrations BEFORE anything reads or seeds the schema,
// so a fresh clone (or a fresh database) boots with the tables in place. The
// migrator is idempotent — already-applied migrations are skipped. Path is
// resolved from this module so cwd doesn't matter.
await migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });

// Idempotent boot seeding: dev org/user/member + the mocked skills.
await seedDev();

// Recover orphaned runs from a previous (unclean) shutdown.
const recovered = await failStaleRuns();
if (recovered > 0) console.log(`[boot] marked ${recovered} stale run(s) as failed`);

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

// better-auth: email/password + organization plugin, mounted at /api/auth/*.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/api/runs", runsRoutes);
app.route("/api/skills", skillsRoutes);
app.route("/api/schedules", schedulesRoutes);
app.route("/api/knowledge", knowledgeRoutes);

// Always-on scheduler loop (60s tick). Harmless when no schedule is enabled —
// schedules default disabled, so nothing auto-fires until a human turns it on.
startScheduler();

// Slack adapter: mounted only when SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET are
// set (env-gated). Handles the Events API at POST /api/slack/events.
if (slackEnabled()) {
  app.route("/api/slack", slackRoutes);
  console.log("[slack] adapter enabled — POST /api/slack/events");
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
};
