/**
 * Environment configuration. Bun auto-loads `.env`; everything is read from
 * `process.env` with dev-friendly defaults so the server boots with zero setup.
 */

import { ENGINE_IDS, type EngineId } from "./db/schema";
import {
  authSecretMaterial,
  runtimeDevModeEnabled,
} from "./security/runtime-secrets";

/**
 * Dev mode gates every fail-OPEN behavior in the app: the seeded dev-org
 * fallback for unauthenticated requests (middleware/org.ts), the insecure
 * default auth secret (below), and the store-a-stub-on-LLM-failure path
 * (knowledge/ingest.ts). It defaults to true UNLESS NODE_ENV is "production";
 * an explicit SKYNET_DEV_MODE always wins. Evaluated per call so tests can flip
 * it at runtime without a fresh process.
 */
export function devModeEnabled(): boolean {
  return runtimeDevModeEnabled();
}

/**
 * Whether the seeded dev-org fallback for unauthenticated requests is allowed
 * (middleware/org.ts). Dedicated production switch, independent of the broader
 * dev-mode toggles: set `ALLOW_DEV_ORG=0` to force real auth on every domain
 * route even in dev. Default follows {@link devModeEnabled} so nothing breaks
 * today (ON in dev, OFF in production). Read per call so a deploy can flip it.
 */
export function allowDevOrg(): boolean {
  const flag = process.env.ALLOW_DEV_ORG;
  if (flag !== undefined) return flag === "1" || flag === "true";
  return devModeEnabled();
}

/** Self-service account creation is a development convenience only. Production
 * users must arrive through an existing account or an administrator-managed
 * invitation; there is deliberately no environment override that can reopen
 * public signup on a production process. */
export function selfSignupEnabled(): boolean {
  return devModeEnabled();
}

/**
 * Which engines may actually run. SECURITY GATE (final_harness.md P0): the
 * Claude/Codex ACP adapters are registered but still require an operator-provisioned
 * provider gateway and an explicit permission posture. They must never be activatable
 * through a direct `engine` on POST /api/runs - or any channel - unless an operator
 * explicitly opts in. The base set is the proven Chat/OpenCode/scripted path; the
 * `ENABLED_ENGINES` env (comma list) only ADDS engines on top
 * (e.g. `ENABLED_ENGINES=claude,codex`) and can never disable the base. Read per
 * call so a deploy flips it without a rebuild; unknown ids are ignored.
 */
const BASE_ENABLED_ENGINES: readonly EngineId[] = ["mock", "opencode", "daytona", "chat"];

export function enabledEnginesForEnv(
  env: Record<string, string | undefined>,
): Set<EngineId> {
  const set = new Set<EngineId>(BASE_ENABLED_ENGINES);
  const extra = env.ENABLED_ENGINES;
  if (extra) {
    for (const raw of extra.split(",")) {
      const id = raw.trim().toLowerCase();
      if ((ENGINE_IDS as readonly string[]).includes(id)) set.add(id as EngineId);
    }
  }
  return set;
}

export function enabledEngines(): Set<EngineId> {
  return enabledEnginesForEnv(process.env);
}

/** True iff `engine` is permitted to run in this deployment. Fail closed: an
 *  unknown or not-opted-in engine is not enabled. */
export function isEngineEnabled(engine: string): boolean {
  return enabledEngines().has(engine as EngineId);
}

/**
 * DEV-ONLY escape hatch to auto-approve ACP permission requests (yolo). Default
 * OFF (fail CLOSED): final_harness.md P0 forbids auto-approving tool permissions
 * in a team/SaaS deployment. The real fix is a trusted-backend approval policy
 * evaluated outside the sandbox (Phase 3); until then ACP permission requests are
 * DENIED unless an operator explicitly sets ACP_YOLO_APPROVE=1 for a local run.
 */
export function acpAutoApprove(): boolean {
  // Require VERIFIED development mode: in production (NODE_ENV=production /
  // SKYNET_DEV_MODE=false) this is always false no matter what ACP_YOLO_APPROVE
  // is set to, so the escape hatch can never be flipped on for a real deployment.
  if (!devModeEnabled()) return false;
  return process.env.ACP_YOLO_APPROVE === "1" || process.env.ACP_YOLO_APPROVE === "true";
}

/** Resolve the auth secret. Production (dev mode off) must supply its own. */
function resolveAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (secret) return secret;
  if (!devModeEnabled()) {
    throw new Error(
      "BETTER_AUTH_SECRET is required when SKYNET_DEV_MODE is off (production). " +
        "Set a strong secret and restart.",
    );
  }
  console.warn(
    "[env] BETTER_AUTH_SECRET is unset — using an insecure dev default. " +
      "Set it before deploying to production.",
  );
  return authSecretMaterial();
}

export const env = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/skynet",
  PORT: Number(process.env.PORT ?? 3201),
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN ?? "http://localhost:3200",
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:3201",
  // Lazy so the dedicated gateway process can reuse non-auth configuration
  // helpers without importing the backend's cookie-signing root. The full app's
  // auth module reads this getter at boot and keeps the same fail-closed policy.
  get BETTER_AUTH_SECRET(): string {
    return resolveAuthSecret();
  },
} as const;

/**
 * Team-memory (TencentDB-Agent-Memory) config for the optional shared memory
 * layer wired into the run context preamble (see src/memory/team-memory.ts).
 *
 * Read per call — like devModeEnabled() — so a deploy can toggle memory without
 * a rebuild and tests can flip it at runtime. `MEMORY_API_URL` unset → the whole
 * layer is a fast no-op, so the backend runs unchanged with zero memory setup.
 *
 * `MEMORY_API_URL` points at the memory-core gateway (default port 8420);
 * `MEMORY_API_KEY` is its `Authorization: Bearer` value. The service id + three
 * isolation ids carry dev defaults so a single-team local bring-up needs only
 * the URL (+ key); a multi-tenant deploy overrides them. See memory/README.md.
 */
export interface MemoryConfig {
  url: string;
  apiKey: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
}

export function memoryConfig(): MemoryConfig | null {
  const url = process.env.MEMORY_API_URL?.trim();
  if (!url) return null;
  return {
    url: url.replace(/\/+$/, ""),
    apiKey: process.env.MEMORY_API_KEY ?? "",
    serviceId: process.env.MEMORY_SERVICE_ID ?? "skynet",
    teamId: process.env.MEMORY_TEAM_ID ?? "skynet",
    agentId: process.env.MEMORY_AGENT_ID ?? "skynet-backend",
    userId: process.env.MEMORY_USER_ID ?? "skynet",
  };
}

/**
 * Google social-sign-in config for better-auth (src/auth.ts). Gated exactly like
 * slackConfig(): read per call; BOTH `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
 * must be set or the provider is off — `googleAuthConfig()` returns null, the
 * "Continue with Google" button is disabled, and email/password still works. A
 * partial (one of the two set) is a misconfiguration: warn and stay off rather
 * than half-enable.
 *
 * The OAuth redirect URI Google must allow is `<BETTER_AUTH_URL>/api/auth/
 * callback/google`; set `BETTER_AUTH_URL` to the public app origin so the session
 * cookie lands first-party (the Next `/api/*` rewrite proxies it to the backend).
 */
export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
}

export function googleAuthConfig(): GoogleAuthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return null; // unset → silently off
  if (!clientId || !clientSecret) {
    console.warn(
      "[auth] GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET is only partially set — " +
        "Google sign-in disabled. Set both or neither.",
    );
    return null;
  }
  return { clientId, clientSecret };
}

/** True when the Google provider is fully configured (both keys present). */
export function googleAuthEnabled(): boolean {
  return googleAuthConfig() !== null;
}

/**
 * GitHub config for real repository selection (src/github/*). Backend-only: the
 * token NEVER reaches React — it authenticates the repo listing here and rides
 * into a sandbox ONLY as a narrow, one-shot clone credential (see the adapter).
 *
 * Read per call (like memoryConfig/slackConfig) so a deploy can add a token
 * without a rebuild. `token` accepts the standard aliases GITHUB_TOKEN /
 * GH_TOKEN / GITHUB_PAT (a PAT or a pre-minted installation token). `owner` is
 * the org/user whose repos to list (GITHUB_ORG / GITHUB_OWNER); when unset and a
 * token is present we list the token user's own repos instead.
 *
 * "Configured" means we can list SOMETHING: a token (list the user's repos) or
 * an owner (list that org/user's PUBLIC repos unauthenticated, or private too
 * when a token is also set). Neither → the whole feature is a graceful no-op and
 * the API reports `configured:false`.
 *
 * NOTE (credential model): when no PAT is set, a configured GitHub *App*
 * (GITHUB_APP_*) is the fallback — {@link githubAppConfig} exposes its creds and
 * src/github/app-auth.ts mints short-lived installation tokens from them (the
 * narrowest practical credential; private-repo listing + clone ride that token).
 * Precedence is PAT > App > unconfigured; see {@link githubAuthSource}. The App
 * creds live in backend/.env, synced from the root .env by
 * scripts/sync-github-app-env.ts.
 */
export interface GithubConfig {
  token: string | null;
  owner: string | null;
}

export function githubConfig(): GithubConfig {
  const token =
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.GITHUB_PAT?.trim() ||
    null;
  const owner =
    process.env.GITHUB_ORG?.trim() || process.env.GITHUB_OWNER?.trim() || null;
  return { token, owner };
}

/**
 * GitHub App credentials (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY). Read per call
 * like the other config resolvers; returns null unless BOTH the app id and a
 * PEM-looking private key are present, so a partial/garbage config disables the
 * App path with a warning rather than half-enabling it.
 *
 * `org` (GITHUB_ORG / GITHUB_OWNER) selects which installation to use when the
 * App is installed on more than one account. The private key is normalized so a
 * quoted single-line `.env` value with `\n` escapes and a real multi-line PEM
 * both work. src/github/app-auth.ts turns these into a short-lived installation
 * token; the token — never these creds — is what touches GitHub or a sandbox.
 */
export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  org: string | null;
}

/** Decode an `.env`-stored PEM: strip wrapping quotes and turn `\n` into newlines. */
function normalizeGithubPem(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  if (s.includes("\\n")) s = s.replace(/\\n/g, "\n");
  return s.trim();
}

export function githubAppConfig(): GithubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId && !rawKey) return null; // unset → silently off
  if (!appId || !rawKey) {
    console.warn(
      "[github] GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY is only partially set — " +
        "GitHub App auth disabled. Set both or neither.",
    );
    return null;
  }
  const privateKey = normalizeGithubPem(rawKey);
  if (!privateKey.includes("-----BEGIN")) {
    console.warn(
      "[github] GITHUB_APP_PRIVATE_KEY is set but is not a PEM private key — " +
        "GitHub App auth disabled.",
    );
    return null;
  }
  const org =
    process.env.GITHUB_ORG?.trim() || process.env.GITHUB_OWNER?.trim() || null;
  return { appId, privateKey, org };
}

/** How repo listing + clone will authenticate. PAT wins; then a configured App;
 *  else anonymous (public repos of an owner, if one is set). */
export type GithubAuthSource = "pat" | "app" | "anon";

export function githubAuthSource(): GithubAuthSource {
  if (githubConfig().token) return "pat";
  if (githubAppConfig()) return "app";
  return "anon";
}

/** True when repo listing can return anything: a PAT, a GitHub App, or an owner
 *  (whose public repos we can list unauthenticated). */
export function githubConfigured(): boolean {
  const { token, owner } = githubConfig();
  return Boolean(token || owner || githubAppConfig());
}

/**
 * Product-organization id allowed to use the deployment-wide GitHub
 * connection. GitHub credentials are still process configuration rather than
 * per-org records, so they must be assigned to exactly one product tenant.
 *
 * `GITHUB_TENANT_ORG_ID` is the canonical binding. The two fallbacks preserve
 * the current single-tenant deployment while it migrates: the host bootstrap
 * already receives `SKYNET_PRIMARY_ORG_ID`, and older installs carry their
 * tenant id in `SLACK_DEFAULT_ORG_ID`. Local development stays bound to the
 * seeded dev org only while the dev-org fallback is explicitly enabled.
 */
export function githubTenantOrgId(): string | null {
  return (
    process.env.GITHUB_TENANT_ORG_ID?.trim() ||
    process.env.SKYNET_PRIMARY_ORG_ID?.trim() ||
    process.env.SLACK_DEFAULT_ORG_ID?.trim() ||
    (allowDevOrg() ? "org-skynet-dev" : null)
  );
}

/**
 * Slack adapter config for the optional Events-API integration (src/slack/*).
 * Gated exactly like memoryConfig(): read per call, and BOTH `SLACK_BOT_TOKEN`
 * and `SLACK_SIGNING_SECRET` must be set or the whole adapter is a no-op —
 * `slackConfig()` returns null, the events route 404s, nothing touches Slack.
 *
 * `SLACK_DEFAULT_ENGINE` (default "opencode") picks the engine a Slack-started
 * run uses; `SLACK_DEFAULT_MODEL` (default "claude-opus-5") its model.
 * `SLACK_API_URL` (default Slack) is overridable for tests. Only the HTTP
 * Events path is ported — no Socket Mode / app token in v1.
 * `SLACK_CHANNEL_ALLOWLIST` (comma-separated channel ids) restricts where
 * server-initiated messages (automation notifications/delivery) may post;
 * unset/empty = no restriction.
 */
export interface SlackConfig {
  botToken: string;
  signingSecret: string;
  apiUrl: string;
  defaultEngine: EngineId;
  model: string;
  /** Channel ids the adapter may ingest from (empty = all channels). Set via
   *  SLACK_CHANNEL_ALLOWLIST (comma-separated) to scope a fresh workspace
   *  connection to designated test channels. */
  channelAllowlist: ReadonlySet<string>;
}

const SLACK_ENGINES: readonly EngineId[] = ENGINE_IDS;

export function slackConfig(): SlackConfig | null {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim();
  if (!botToken || !signingSecret) return null;

  const rawEngine = process.env.SLACK_DEFAULT_ENGINE?.trim();
  const defaultEngine =
    rawEngine && SLACK_ENGINES.includes(rawEngine as EngineId)
      ? (rawEngine as EngineId)
      : "opencode";

  const rawUrl = (process.env.SLACK_API_URL ?? "https://slack.com/api/").replace(/\/+$/, "");
  const apiUrl = rawUrl.endsWith("/api") ? `${rawUrl}/` : `${rawUrl}/api/`;

  const channelAllowlist = new Set(
    (process.env.SLACK_CHANNEL_ALLOWLIST ?? "")
      .split(",")
      .map((channel) => channel.trim())
      .filter(Boolean),
  );

  return {
    botToken,
    signingSecret,
    apiUrl,
    defaultEngine,
    model: process.env.SLACK_DEFAULT_MODEL?.trim() || "claude-opus-5",
    channelAllowlist,
  };
}

/** True when the Slack adapter is fully configured (both secrets present). */
export function slackEnabled(): boolean {
  return slackConfig() !== null;
}

/**
 * Email connector config (src/connectors/email/*). Gated like slackConfig():
 * read per call; the connector is a no-op unless `CONNECTOR_EMAIL_NOTIFY` is
 * `all` or `failed` (the trigger) AND a `from` + at least one allow-listed `to`
 * recipient are set. `all` mails every run completion, `failed` only failures.
 *
 * `CONNECTOR_EMAIL_DRYRUN=true` logs the fully-rendered payload instead of
 * sending (no SMTP host required). A real send needs `CONNECTOR_EMAIL_HOST`
 * (+ optional `PORT`/`SECURE`/`USER`/`PASS`); `to` is a comma-separated frozen
 * outbound allow-list. Any partial/inconsistent config disables the connector
 * with a warning rather than half-sending.
 */
export type ConnectorEmailNotify = "all" | "failed";

export interface ConnectorEmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string[];
  notify: ConnectorEmailNotify;
  dryRun: boolean;
}

export function connectorEmailConfig(): ConnectorEmailConfig | null {
  const notify = process.env.CONNECTOR_EMAIL_NOTIFY?.trim();
  if (notify !== "all" && notify !== "failed") return null; // unset/invalid → off

  const from = process.env.CONNECTOR_EMAIL_FROM?.trim() || "";
  const to = (process.env.CONNECTOR_EMAIL_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!from || to.length === 0) {
    console.warn(
      "[connectors/email] CONNECTOR_EMAIL_NOTIFY is set but FROM/TO are incomplete — connector disabled.",
    );
    return null;
  }

  const dryRun = process.env.CONNECTOR_EMAIL_DRYRUN === "true";
  const host = process.env.CONNECTOR_EMAIL_HOST?.trim() || "";
  const port = Number(process.env.CONNECTOR_EMAIL_PORT ?? 587);
  const secure = process.env.CONNECTOR_EMAIL_SECURE === "true" || port === 465;

  if (!dryRun && !host) {
    console.warn(
      "[connectors/email] not in dry-run and CONNECTOR_EMAIL_HOST is unset — connector disabled. " +
        "Set CONNECTOR_EMAIL_DRYRUN=true to log payloads instead.",
    );
    return null;
  }

  return {
    host,
    port,
    secure,
    user: process.env.CONNECTOR_EMAIL_USER?.trim() || undefined,
    pass: process.env.CONNECTOR_EMAIL_PASS || undefined,
    from,
    to,
    notify,
    dryRun,
  };
}
