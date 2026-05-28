import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { EngineRunContext } from "../engines/types";
import { recordProviderEvent } from "../runs/provider-events";
import { runtimeDevModeEnabled } from "../security/runtime-secrets";
import { isReservedSecretName } from "./crypto";
import { decryptOrgSecrets, type DecryptedSecrets } from "./store";

// ---------------------------------------------------------------------------
// Sandbox secret delivery (task #100). Production defaults to gateway-only:
// decrypted values stay in backend memory for redaction and trusted gateway
// consumers, while the sandbox receives no env, names, or files. Development
// retains the historical compatibility delivery path described below.
//
// DELIVERY (why a dotenv, not N env vars): passing hundreds of env vars to
// daytona.create is rejected by Daytona (confirmed A/B: 2 vars create OK, 485
// vars create FAILS - a real org catalog is 400+ secrets). So org secrets do NOT
// ride in the container-create request. Instead a SINGLE tiny create-env var,
// `BASH_ENV=<dotenv path>`, points at a 0600 dotenv written into the sandbox
// after boot. Engine launch commands also source that file explicitly because
// Daytona snapshots are not shell-uniform: some launch through zsh, which does
// not honor BASH_ENV. The engine process then passes the environment to tools.
// Bonus: org secrets never appear in the container-create request at all, which
// advances the "don't leak into untrusted sandboxes" posture (BUG-002 / #116).
//
// SPLIT (deliberate): in compatibility mode, non-provider org secrets go in this
// dotenv. Provider credentials are always withheld by the engine adapters and
// resolved tenant-side by the trusted provider gateway. There is no raw host-key
// escape hatch.
//
// BASH_ENV remains a compatibility path for non-interactive Bash commands, but
// correctness does not depend on it. OpenCode, ACP, and CLI adapters explicitly
// source the dotenv before starting the long-lived engine process.
//
// Two kinds inside the dotenv:
//  - "env":  export NAME='value'.
//  - "file": the value is also materialized to a 0600 file at SECRET_FILE_DIR/NAME
//    and the export is NAME='<that path>' (for file-shaped creds - a GCP
//    service-account JSON, a PEM key; e.g. GOOGLE_APPLICATION_CREDENTIALS).
// ---------------------------------------------------------------------------

/** The native `eventType` for a secrets-injection marker. */
export const SECRETS_INJECTED = "secrets.injected";

const DEFAULT_SECRET_FILE_DIR = "$HOME/.skynet/secrets";
const HOME_RELATIVE_DIR_RE = /^\$HOME(?:\/[A-Za-z0-9._-]+)+$/;
const ABSOLUTE_DIR_RE = /^\/(?:[A-Za-z0-9._-]+\/?)+$/;

/** Where file-kind secrets (and the dotenv) are materialized inside the sandbox.
 *  `$HOME` is intentionally left for the sandbox shell to expand: Daytona
 *  snapshots currently include both root and non-root users. An absolute ops
 *  override is still supported, but shell metacharacters are rejected at boot. */
function resolveSecretFileDir(): string {
  const configured = process.env.SECRETS_FILE_DIR?.trim();
  const candidate = (configured || DEFAULT_SECRET_FILE_DIR).replace(/\/+$/, "");
  if (!HOME_RELATIVE_DIR_RE.test(candidate) && !ABSOLUTE_DIR_RE.test(candidate)) {
    throw new Error(
      "SECRETS_FILE_DIR must be an absolute path or a safe $HOME-relative path",
    );
  }
  return candidate;
}

export const SECRET_FILE_DIR = resolveSecretFileDir();

/** The dotenv explicitly sourced at engine boot (and exposed through BASH_ENV
 * for compatible non-interactive Bash commands). */
export const SECRET_DOTENV_PATH = `${SECRET_FILE_DIR}/skynet-env.sh`;

const DOTENV_BASENAME_RE = /^\.env(?:\..+)?$/;

/** Artifact publication must never expose the injected-secret directory or a
 * dotenv file, even when the agent addresses the home directory explicitly. */
export function isProtectedInjectedSecretPath(value: string): boolean {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  const basename = normalized.split("/").at(-1) ?? "";
  if (DOTENV_BASENAME_RE.test(basename)) return true;

  const secretDir = SECRET_FILE_DIR.replaceAll("\\", "/");
  if (secretDir.startsWith("$HOME/")) {
    const suffix = secretDir.slice("$HOME".length);
    const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expandedHomePath = new RegExp(
      `^/(?:root|home/[^/]+)${escapedSuffix}(?:/|$)`,
    );
    return (
      normalized === secretDir ||
      normalized.startsWith(`${secretDir}/`) ||
      normalized === `~${suffix}` ||
      normalized.startsWith(`~${suffix}/`) ||
      expandedHomePath.test(normalized)
    );
  }
  return normalized === secretDir || normalized.startsWith(`${secretDir}/`);
}

/** Compatibility-only secrets.injected payload - the injected NAMES and their
 * count, never any value. Gateway-only mode emits no marker. */
export interface SecretsInjectedPayload {
  readonly names: string[];
  readonly count: number;
  readonly source: "secrets";
}

/** A file to write inside the sandbox (the dotenv, or a file-kind secret). */
export interface SecretFile {
  path: string;
  content: string;
}

/** The result of composing an org's secrets for one run. */
export interface SecretInjection {
  /** Whether the sandbox compatibility delivery path is enabled for this run. */
  mode: SandboxSecretMode;
  /** Env vars to pass to daytona.create - TINY: just `BASH_ENV` when any secret
   *  exists (never the secrets themselves). Engine boot also sources the file. */
  createEnv: Record<string, string>;
  /** Files to materialize inside the sandbox AFTER boot: the dotenv first, then
   *  each file-kind secret's content. Written 0600 by materializeSecretFiles. */
  files: SecretFile[];
  /** Every injected secret name (for the marker). */
  names: string[];
  /** Values held in memory only so engine output can be redacted before it is
   * persisted. Never include these in a marker, log, or provider event. */
  redactionValues: string[];
}

export type SandboxSecretMode = "gateway_only" | "compatibility";

/** Production defaults to gateway-only. Local development keeps the historical
 * sandbox delivery path unless an operator explicitly selects a valid mode. */
export function sandboxSecretMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SandboxSecretMode {
  const configured = env.SANDBOX_SECRET_MODE?.trim().toLowerCase();
  if (configured === "compatibility") {
    if (env.NODE_ENV?.trim().toLowerCase() === "production" || !runtimeDevModeEnabled(env)) {
      throw new Error("SANDBOX_SECRET_MODE=compatibility is forbidden outside development");
    }
    return configured;
  }
  if (configured === "gateway_only") return configured;
  return runtimeDevModeEnabled(env) ? "compatibility" : "gateway_only";
}

function emptyInjection(mode: SandboxSecretMode): SecretInjection {
  return { mode, createEnv: {}, files: [], names: [], redactionValues: [] };
}

const LEGACY_GCP_CREDENTIAL = "GCP_SERVICE_ACCOUNT_KEY";
const GOOGLE_APPLICATION_CREDENTIALS = "GOOGLE_APPLICATION_CREDENTIALS";
const GOOGLE_PROJECT_ENV_NAMES = [
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
] as const;
const GOOGLE_PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Provider credentials never cross into an untrusted sandbox. */
export const PROVIDER_SECRET_NAMES = new Set([
  // External cloud credentials stay in the trusted control plane. Sandboxes use
  // run-bound gateway tools such as gcs_list_buckets instead of raw key files.
  "GCP_SERVICE_ACCOUNT_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_ENVIRONMENT_KEY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_HFI_BEARER_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ACCESS_TOKEN",
  "OPENROUTER_API_KEY",
  "CODEX_ACCESS_TOKEN",
]);

/** POSIX single-quote an opaque value. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Render a validated sandbox path. `$HOME` paths use double quotes so the
 *  sandbox user's real home is resolved when Bash sources or executes it. */
function shellPath(path: string): string {
  return path.startsWith("$HOME/") ? `"${path}"` : shellQuote(path);
}

/** The dotenv path as a shell expression (quoted, `$HOME` left for the sandbox
 *  shell to expand) - for launch scripts that need to test or export it. */
export const SECRET_DOTENV_SHELL_PATH = shellPath(SECRET_DOTENV_PATH);

/** Shell-neutral engine boot prefix. Do not rely on Daytona's command launcher
 *  honoring BASH_ENV: current snapshots invoke both zsh and bash. */
export const SECRET_SOURCE_COMMAND = `. ${SECRET_DOTENV_SHELL_PATH}`;

/** Engine launch prefix for the selected delivery mode. `:` is a shell no-op,
 * so gateway-only launches do not require or source a sandbox dotenv. */
export function sandboxSecretSourceCommand(
  mode: SandboxSecretMode = sandboxSecretMode(),
): string {
  return mode === "compatibility" ? SECRET_SOURCE_COMMAND : ":";
}

/** Export an opaque value without permitting shell evaluation. */
function shellExport(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}`;
}

/** Export one of this module's validated file paths with `$HOME` expansion. */
function shellExportPath(name: string, path: string): string {
  return `export ${name}=${shellPath(path)}`;
}

/** Read the standard project_id embedded in a Google service-account JSON file.
 *  Invalid JSON and non-project credential files intentionally produce no aliases. */
function googleProjectId(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || !("project_id" in parsed)) return null;
    const projectId = (parsed as { project_id?: unknown }).project_id;
    return typeof projectId === "string" && GOOGLE_PROJECT_ID_RE.test(projectId)
      ? projectId
      : null;
  } catch {
    return null;
  }
}

/**
 * Map decrypted secrets to one run's delivery/redaction state. Compatibility
 * mode produces the historical dotenv/files/BASH_ENV payload; gateway-only mode
 * returns only in-memory redaction values. Pure (no marker, no I/O) so it is
 * unit-testable.
 */
export function buildInjection(
  decrypted: DecryptedSecrets,
  options: {
    readonly excludeNames?: ReadonlySet<string>;
    readonly mode?: SandboxSecretMode;
  } = {},
): SecretInjection {
  const mode = options.mode ?? sandboxSecretMode();
  const included = decrypted.secrets.filter(
    (secret) =>
      !isReservedSecretName(secret.name) &&
      !options.excludeNames?.has(secret.name),
  );
  if (included.length === 0) {
    return emptyInjection(mode);
  }
  const redactionValues = included.map((secret) => secret.value);
  if (mode === "gateway_only") {
    return { mode, createEnv: {}, files: [], names: [], redactionValues };
  }
  const files: SecretFile[] = [];
  const lines: string[] = [];
  const includedNames = new Set(included.map((secret) => secret.name));
  for (const s of included) {
    if (s.kind === "file") {
      const path = `${SECRET_FILE_DIR}/${s.name}`;
      files.push({ path, content: s.value });
      lines.push(shellExportPath(s.name, path)); // the agent reads the file at this path
    } else {
      lines.push(shellExport(s.name, s.value));
    }
  }

  // Historical imports named the Google service-account file
  // GCP_SERVICE_ACCOUNT_KEY. Keep that name available while also exporting the
  // standard variables Google SDKs and CLIs discover automatically. An explicit
  // canonical secret always wins, so this compatibility seam cannot override an
  // administrator's configuration.
  const canonicalGoogleCredential = included.find(
    (secret) => secret.name === GOOGLE_APPLICATION_CREDENTIALS,
  );
  const legacyGoogleCredential = included.find(
    (secret) => secret.name === LEGACY_GCP_CREDENTIAL && secret.kind === "file",
  );
  if (!canonicalGoogleCredential && legacyGoogleCredential) {
    lines.push(
      shellExportPath(
        GOOGLE_APPLICATION_CREDENTIALS,
        `${SECRET_FILE_DIR}/${LEGACY_GCP_CREDENTIAL}`,
      ),
    );
  }

  const effectiveGoogleCredential = canonicalGoogleCredential ?? legacyGoogleCredential;
  const projectId =
    effectiveGoogleCredential?.kind === "file"
      ? googleProjectId(effectiveGoogleCredential.value)
      : null;
  if (projectId) {
    for (const name of GOOGLE_PROJECT_ENV_NAMES) {
      if (!includedNames.has(name)) lines.push(shellExport(name, projectId));
    }
  }

  // The dotenv is written FIRST (BASH_ENV points at it); a trailing newline keeps
  // the last export well-formed.
  files.unshift({ path: SECRET_DOTENV_PATH, content: `${lines.join("\n")}\n` });
  return {
    mode,
    createEnv: { BASH_ENV: SECRET_DOTENV_PATH },
    files,
    names: included.map((secret) => secret.name),
    redactionValues,
  };
}

/** Load the exact org-secret values eligible for sandbox injection. Artifact
 * publication uses this fail-closed boundary instead of the availability-safe
 * composeSecretEnv wrapper: a lookup failure must not permit unscanned bytes. */
export async function loadInjectedSecretRedactionValues(orgId: string): Promise<string[]> {
  const decrypted = await decryptOrgSecrets(orgId);
  return buildInjection(decrypted, { excludeNames: PROVIDER_SECRET_NAMES }).redactionValues;
}

/**
 * Decrypt the run's org secrets into an injectable form. A null org, no secrets,
 * or an all-undecryptable set yields an empty injection. This stage stays
 * availability-safe; the later filesystem materialization is the fail-closed
 * boundary.
 */
export async function composeSecretEnv(
  ctx: EngineRunContext,
  options: { readonly excludeNames?: ReadonlySet<string> } = {},
): Promise<SecretInjection> {
  const mode = sandboxSecretMode();
  // Null org → no tenancy → inject nothing (fail closed, like gateway wiring).
  if (!ctx.orgId) return emptyInjection(mode);

  let decrypted;
  try {
    decrypted = await decryptOrgSecrets(ctx.orgId);
  } catch (err) {
    console.warn(
      `[secrets] decrypt failed for org ${ctx.orgId}; injecting no secrets:`,
      err instanceof Error ? err.message : err,
    );
    return emptyInjection(mode);
  }

  if (decrypted.names.length === 0) return emptyInjection(mode); // no marker for a non-event

  const out = buildInjection(decrypted, { ...options, mode });

  return out.redactionValues.length === 0 ? emptyInjection(mode) : out;
}

/** Record successful injection only after the sandbox files exist. Keeping this
 * separate from composition prevents a durable false-positive when Daytona
 * cannot create the protected directory or write the dotenv. */
export async function recordSecretsInjected(
  ctx: EngineRunContext,
  injection: SecretInjection,
): Promise<void> {
  if (injection.names.length === 0) return;
  await recordProviderEvent({
    id: `secretsinjected_${ctx.runId}`,
    runId: ctx.runId,
    threadId: ctx.threadId ?? ctx.runId,
    provider: "skynet",
    eventType: SECRETS_INJECTED,
    payload: {
      names: injection.names,
      count: injection.names.length,
      source: "secrets",
    } satisfies SecretsInjectedPayload,
  });
}

/**
 * Write injection files (the dotenv + any file-kind secrets) into a live sandbox,
 * each 0600 under a 0700 dir. `runCmd` runs one shell command in the sandbox
 * (e.g. `sandbox.process.executeCommand`). Content is base64-piped so a secret
 * never appears literally on the command line and no shell-escaping of its bytes
 * is needed. A failed or indeterminate command throws: the engine must not run
 * with a credential surface that the control plane claimed to inject.
 */
export async function materializeSecretFiles(
  runCmd: (cmd: string) => Promise<{
    readonly exitCode?: number;
    readonly result?: string;
  }>,
  files: SecretFile[],
): Promise<{ readonly changed: boolean }> {
  // Reconciliation is intentional even for an empty current secret set: a warm
  // sandbox may still contain a dotenv/files from a prior turn whose secrets
  // were revoked. Keep an empty dotenv so every engine can source one fixed path.
  const currentFiles = files.length > 0
    ? files.toSorted((a, b) => a.path.localeCompare(b.path))
    : [{ path: SECRET_DOTENV_PATH, content: "" }];
  const pathPrefix = `${SECRET_FILE_DIR}/`;
  if (currentFiles.some((file) => !file.path.startsWith(pathPrefix))) {
    throw new Error("secret materialization path escaped the protected directory");
  }

  const digest = createHash("sha256");
  for (const file of currentFiles) {
    digest.update(file.path).update("\0").update(file.content).update("\0");
  }
  const revision = digest.digest("hex");
  const directory = shellPath(SECRET_FILE_DIR);
  const revisionPath = shellPath(`${SECRET_FILE_DIR}/.revision`);
  const unchangedChecks = [
    `[ "$(cat ${revisionPath} 2>/dev/null || true)" = '${revision}' ]`,
    `test -f ${revisionPath} && test ! -L ${revisionPath}`,
    `[ "$(stat -c %a -- ${revisionPath} 2>/dev/null || true)" = 600 ]`,
    `[ "$(find ${directory} -mindepth 1 -maxdepth 1 | wc -l)" -eq ${currentFiles.length + 1} ]`,
    ...currentFiles.flatMap((file) => {
      const path = shellPath(file.path);
      const contentHash = createHash("sha256").update(file.content).digest("hex");
      return [
        `test -f ${path} && test ! -L ${path}`,
        `[ "$(stat -c %a -- ${path} 2>/dev/null || true)" = 600 ]`,
        `[ "$(sha256sum -- ${path} 2>/dev/null | cut -d ' ' -f1)" = '${contentHash}' ]`,
      ];
    }),
  ];
  // Tool-shell delivery: T3 spawns tool shells that read the standard rc files
  // but do NOT inherit a secrets-bearing environment (and must not - sourcing
  // the dotenv into the T3 process env broke the codex subscription dial, see
  // the 2026-08-18 release-gate incident). An idempotent source hook in each rc
  // file gives every tool shell the CURRENT dotenv at spawn time, which also
  // covers warm sandboxes whose secrets were re-seeded after boot. The hook line
  // itself contains no secret material.
  const hookLine = `. ${SECRET_DOTENV_SHELL_PATH} 2>/dev/null || true`;
  const installRcHooks =
    `for rc in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.zshenv"; do ` +
    `grep -qsF 'skynet-env.sh' "$rc" || printf '\\n%s\\n' ${shellQuote(hookLine)} >> "$rc"; ` +
    `done`;
  const cmds = [
    "umask 077",
    `test ! -L ${directory}`,
    `mkdir -p -- ${directory}`,
    `test -d ${directory}`,
    `chmod 700 -- ${directory}`,
    installRcHooks,
    `if ${unchangedChecks.join(" && ")}; then printf unchanged; exit 0; fi`,
    `find ${directory} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
  ];
  for (const f of currentFiles) {
    const b64 = Buffer.from(f.content, "utf8").toString("base64");
    const path = shellPath(f.path);
    cmds.push(`printf '%s' '${b64}' | base64 -d > ${path} && chmod 600 -- ${path}`);
  }
  cmds.push(
    `printf '%s' '${revision}' > ${revisionPath} && chmod 600 -- ${revisionPath}`,
    "printf changed",
  );
  const result = await runCmd(cmds.join(" && "));
  if (result.exitCode !== 0) {
    throw new Error(
      `secret materialization command exited ${result.exitCode ?? "without a status"}`,
    );
  }
  return { changed: result.result?.trim().split(/\s+/).at(-1) !== "unchanged" };
}

/** Apply compatibility delivery only when explicitly selected. Gateway-only
 * runs never touch sandbox env, rc files, or the protected secret directory. */
export async function materializeSecretInjection(
  runCmd: (cmd: string) => Promise<{
    readonly exitCode?: number;
    readonly result?: string;
  }>,
  injection: SecretInjection,
): Promise<{ readonly changed: boolean }> {
  if (injection.mode === "gateway_only") return { changed: false };
  return materializeSecretFiles(runCmd, injection.files);
}
