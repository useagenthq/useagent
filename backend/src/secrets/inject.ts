import type { EngineRunContext } from "../engines/types";
import { recordProviderEvent } from "../runs/provider-events";
import { decryptOrgSecrets, type DecryptedSecrets } from "./store";

// ---------------------------------------------------------------------------
// Sandbox secret injection (task #100). At run boot each engine adapter composes
// the org's decrypted secrets ALONGSIDE the existing platform vars, and records a
// durable `secrets.injected` marker on the shared native lane (provider "skynet",
// like skill.loaded / context.retrieved). The marker carries NAMES ONLY - never a
// value. Injection must never fail a run: decryptOrgSecrets swallows per-secret
// failures, and a marker-persist failure is swallowed by recordProviderEvent.
//
// Two kinds:
//  - "env":  NAME=value goes straight into the sandbox process env.
//  - "file": the value is materialized to a 0600 file at SECRET_FILE_DIR/NAME
//    inside the sandbox and the env var NAME is set to that PATH (for file-shaped
//    creds - a GCP service-account JSON, a PEM key). The env var (a path string)
//    is set at sandbox-create time; the file is written after boot via
//    materializeSecretFiles.
// ---------------------------------------------------------------------------

/** The native `eventType` for a secrets-injection marker. */
export const SECRETS_INJECTED = "secrets.injected";

/** Where file-kind secrets are materialized inside the sandbox. Overridable via
 *  SECRETS_FILE_DIR so ops can match the sandbox image's user/home without a code
 *  change (the default assumes a root sandbox). */
export const SECRET_FILE_DIR =
  process.env.SECRETS_FILE_DIR?.trim() || "/root/.secrets";

/** Bounded secrets.injected payload - the injected NAMES and their count, never
 *  any value. `source` mirrors skill.loaded's discriminator for the timeline. */
export interface SecretsInjectedPayload {
  readonly names: string[];
  readonly count: number;
  readonly source: "secrets";
}

/** A file-kind secret to write inside the sandbox. */
export interface SecretFile {
  path: string;
  content: string;
}

/** The result of composing an org's secrets for one run's sandbox. */
export interface SecretInjection {
  /** env-kind values AND file-kind PATHS, ready to merge into the sandbox env. */
  env: Record<string, string>;
  /** file-kind contents to materialize inside the sandbox after boot. */
  files: SecretFile[];
  /** Every injected secret name (for the marker). */
  names: string[];
}

const EMPTY: SecretInjection = { env: {}, files: [], names: [] };

/** Map decrypted secrets to an injection: env-kind → NAME=value; file-kind → a
 *  file to write plus NAME=path. Pure (no marker, no I/O) so it is unit-testable. */
export function buildInjection(decrypted: DecryptedSecrets): SecretInjection {
  const out: SecretInjection = { env: {}, files: [], names: decrypted.names };
  for (const s of decrypted.secrets) {
    if (s.kind === "file") {
      const path = `${SECRET_FILE_DIR}/${s.name}`;
      out.files.push({ path, content: s.value });
      out.env[s.name] = path; // the agent reads the file at this path
    } else {
      out.env[s.name] = s.value;
    }
  }
  return out;
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

  const out = buildInjection(decrypted);

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
      names: decrypted.names,
      count: decrypted.names.length,
      source: "secrets",
    } satisfies SecretsInjectedPayload,
  });

  return out;
}

/**
 * Write file-kind secrets into a live sandbox (0600, under a 0700 dir). `runCmd`
 * runs one shell command in the sandbox (e.g. `sandbox.process.executeCommand`).
 * Content is base64-piped so a secret never appears literally on the command line
 * and no shell-escaping of its bytes is needed. Never throws - a failure is
 * logged and the run proceeds (the env var still points at the path).
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
    await runCmd(cmds.join("; "));
  } catch (err) {
    console.warn(
      "[secrets] file materialization failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
