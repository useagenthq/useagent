import { readFileSync } from "node:fs";

export const USEAGENT_API_COMPAT = "run-events-v1";

const RELEASE_COMMIT_FILE = "/opt/skynet/.release-commit";

export interface ReleaseFingerprint {
  readonly apiCompat: typeof USEAGENT_API_COMPAT;
  readonly commit: string;
  readonly fingerprint: string;
}

function normalizeCommit(value: string | undefined): string | null {
  const commit = value?.trim().toLowerCase();
  return commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null;
}

function fileCommit(path: string): string | null {
  try {
    return normalizeCommit(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function currentReleaseFingerprint(
  env: Record<string, string | undefined> = process.env,
): ReleaseFingerprint {
  const commit =
    normalizeCommit(env.USEAGENT_RELEASE_COMMIT) ??
    fileCommit(env.USEAGENT_RELEASE_COMMIT_FILE ?? RELEASE_COMMIT_FILE) ??
    "dev";
  return {
    apiCompat: USEAGENT_API_COMPAT,
    commit,
    fingerprint: `${USEAGENT_API_COMPAT}:${commit}`,
  };
}

export function isClientReleaseCompatible(
  clientFingerprint: string | undefined,
  serverFingerprint: string,
): boolean {
  if (!clientFingerprint) return true;
  if (clientFingerprint === serverFingerprint) return true;
  return serverFingerprint.endsWith(":dev");
}
