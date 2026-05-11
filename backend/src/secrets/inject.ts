import type { EngineRunContext } from "../engines/types";
import { recordProviderEvent } from "../runs/provider-events";
import { isReservedSecretName } from "./crypto";
import { decryptOrgSecrets, type DecryptedSecrets } from "./store";

// ---------------------------------------------------------------------------
// Sandbox secret injection (task #100). At run boot each engine adapter composes
// the org's decrypted secrets and records a durable `secrets.injected` marker on
// the shared native lane (provider "skynet", like skill.loaded / context.retrieved).
// The marker carries NAMES ONLY - never a value. Injection must never fail a run:
// decryptOrgSecrets swallows per-secret failures, and a marker-persist failure is
// swallowed by recordProviderEvent.
//
// DELIVERY (why a dotenv, not N env vars): passing hundreds of env vars to
// daytona.create is rejected by Daytona (confirmed A/B: 2 vars create OK, 485
// vars create FAILS - a real org catalog is 400+ secrets). So org secrets do NOT
// ride in the container-create request. Instead a SINGLE tiny create-env var,
// `BASH_ENV=<dotenv path>`, points at a 0600 dotenv written into the sandbox
// after boot; Daytona's shell is /usr/bin/bash and auto-sources BASH_ENV on
// EVERY command, so the agent's tool commands see every secret as an env var.
// Bonus: org secrets never appear in the container-create request at all, which
// advances the "don't leak into untrusted sandboxes" posture (BUG-002 / #116).
//
// SPLIT (deliberate): non-provider org secrets go in this dotenv. Provider
// credentials are always withheld by the engine adapters and resolved tenant-
// side by the trusted provider gateway. There is no raw host-key escape hatch.
//
// CAVEAT: BASH_ENV is honored by non-interactive BASH only. Daytona's shell is
// bash (verified), so agent tool commands inherit the dotenv - but a tool that
// spawns a non-bash shell (sh/dash) will not. Acceptable for the agent's bash
// tool calls; file-kind secrets (an absolute path + a real file) work regardless.
//
// Two kinds inside the dotenv:
//  - "env":  export NAME='value'.
//  - "file": the value is also materialized to a 0600 file at SECRET_FILE_DIR/NAME
//    and the export is NAME='<that path>' (for file-shaped creds - a GCP
//    service-account JSON, a PEM key; e.g. GOOGLE_APPLICATION_CREDENTIALS).
// ---------------------------------------------------------------------------

/** The native `eventType` for a secrets-injection marker. */
export const SECRETS_INJECTED = "secrets.injected";

/** Where file-kind secrets (and the dotenv) are materialized inside the sandbox.
 *  Overridable via SECRETS_FILE_DIR so ops can match the sandbox image's
 *  user/home without a code change (the default assumes a root sandbox). */
export const SECRET_FILE_DIR =
  process.env.SECRETS_FILE_DIR?.trim() || "/root/.secrets";

/** The dotenv sourced by BASH_ENV on every sandbox command. */
export const SECRET_DOTENV_PATH = `${SECRET_FILE_DIR}/skynet-env.sh`;

/** Bounded secrets.injected payload - the injected NAMES and their count, never
 *  any value. `source` mirrors skill.loaded's discriminator for the timeline. */
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

/** The result of composing an org's secrets for one run's sandbox. */
export interface SecretInjection {
  /** Env vars to pass to daytona.create - TINY: just `BASH_ENV` when any secret
   *  exists (never the secrets themselves), so create is never rejected. */
  createEnv: Record<string, string>;
  /** Files to materialize inside the sandbox AFTER boot: the dotenv first, then
   *  each file-kind secret's content. Written 0600 by materializeSecretFiles. */
  files: SecretFile[];
  /** Every injected secret name (for the marker). */
  names: string[];
}

const EMPTY: SecretInjection = { createEnv: {}, files: [], names: [] };

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

/** POSIX single-quote a value for a `export NAME='...'` line (escapes embedded
 *  single quotes as '\'' so ANY byte sequence is preserved verbatim). */
function shellExport(name: string, value: string): string {
  return `export ${name}='${value.replace(/'/g, "'\\''")}'`;
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
 * Map decrypted secrets to an injection: a 0600 dotenv of `export NAME='value'`
 * lines (file-kind exports point at the materialized file's path) plus the
 * file-kind content files, and a create-env of just `BASH_ENV`. Pure (no marker,
 * no I/O) so it is unit-testable.
 */
export function buildInjection(
  decrypted: DecryptedSecrets,
  options: { readonly excludeNames?: ReadonlySet<string> } = {},
): SecretInjection {
  const included = decrypted.secrets.filter(
    (secret) =>
      !isReservedSecretName(secret.name) &&
      !options.excludeNames?.has(secret.name),
  );
  if (included.length === 0) return { createEnv: {}, files: [], names: [] };
  const files: SecretFile[] = [];
  const lines: string[] = [];
  const includedNames = new Set(included.map((secret) => secret.name));
  for (const s of included) {
    if (s.kind === "file") {
      const path = `${SECRET_FILE_DIR}/${s.name}`;
      files.push({ path, content: s.value });
      lines.push(shellExport(s.name, path)); // the agent reads the file at this path
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
      shellExport(
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
    createEnv: { BASH_ENV: SECRET_DOTENV_PATH },
    files,
    names: included.map((secret) => secret.name),
  };
}

/**
 * Decrypt the run's org secrets into an injectable form, emitting a names-only
 * `secrets.injected` marker when at least one secret is present. A null org, no
 * secrets, or an all-undecryptable set yields an empty injection and no marker.
 * Never throws - a decrypt failure of the whole set is caught here and a
 * per-secret failure is skipped inside decryptOrgSecrets - so secrets never fail
 * a run.
 */
export async function composeSecretEnv(
  ctx: EngineRunContext,
  options: { readonly excludeNames?: ReadonlySet<string> } = {},
): Promise<SecretInjection> {
  // Null org → no tenancy → inject nothing (fail closed, like gateway wiring).
  if (!ctx.orgId) return EMPTY;

  let decrypted;
  try {
    decrypted = await decryptOrgSecrets(ctx.orgId);
  } catch (err) {
    console.warn(
      `[secrets] decrypt failed for org ${ctx.orgId}; injecting no secrets:`,
      err instanceof Error ? err.message : err,
    );
    return EMPTY;
  }

  if (decrypted.names.length === 0) return EMPTY; // no marker for a non-event

  const out = buildInjection(decrypted, options);

  if (out.names.length === 0) return EMPTY;

  // recordProviderEvent is fire-and-forget-safe (it swallows its own failures and
  // never rejects); await it so the marker is durable before the run can settle,
  // mirroring recordSkillLoaded.
  await recordProviderEvent({
    id: `secretsinjected_${ctx.runId}`,
    runId: ctx.runId,
    threadId: ctx.threadId ?? ctx.runId,
    provider: "skynet",
    eventType: SECRETS_INJECTED,
    payload: {
      names: out.names,
      count: out.names.length,
      source: "secrets",
    } satisfies SecretsInjectedPayload,
  });

  return out;
}

/**
 * Write injection files (the dotenv + any file-kind secrets) into a live sandbox,
 * each 0600 under a 0700 dir. `runCmd` runs one shell command in the sandbox
 * (e.g. `sandbox.process.executeCommand`). Content is base64-piped so a secret
 * never appears literally on the command line and no shell-escaping of its bytes
 * is needed. Never throws - a failure is logged and the run proceeds.
 */
export async function materializeSecretFiles(
  runCmd: (cmd: string) => Promise<unknown>,
  files: SecretFile[],
): Promise<void> {
  if (files.length === 0) return;
  const cmds = [`mkdir -p ${SECRET_FILE_DIR} && chmod 700 ${SECRET_FILE_DIR}`];
  for (const f of files) {
    const b64 = Buffer.from(f.content, "utf8").toString("base64");
    cmds.push(`printf '%s' '${b64}' | base64 -d > '${f.path}' && chmod 600 '${f.path}'`);
  }
  try {
    await runCmd(cmds.join(" && "));
  } catch (err) {
    console.warn(
      "[secrets] file materialization failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
