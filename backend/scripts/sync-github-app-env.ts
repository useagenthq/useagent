/**
 * Sync the GitHub App credentials from the repo-root `.env` into `backend/.env`.
 *
 * The backend only loads `backend/.env`, but the GitHub App creds
 * (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY) live in the root `.env`. This copies
 * the needed lines over, idempotently, so `githubAppConfig()` (src/env.ts) can
 * mint installation tokens and repo listing includes private org repos with no
 * PAT and no manual connect step.
 *
 *   bun run scripts/sync-github-app-env.ts
 *
 * Safety:
 *  - append-only + idempotent: a key already present in backend/.env is left
 *    untouched (never overwritten, never duplicated);
 *  - values are NEVER printed — only key names and an added/kept/skip verdict;
 *  - refuses to run unless backend/.env is gitignored (checked by the caller /
 *    CLAUDE.md), so secrets can't land in a commit.
 *
 * GITHUB_ORG selects which App installation to use; it defaults to upstream-org
 * (the org the App is installed on) when absent from both files.
 */
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT_ENV = resolve(import.meta.dir, "../../.env");
const BACKEND_ENV = resolve(import.meta.dir, "../.env");

/** Keys to carry over from the root .env (in this order). */
const APP_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"] as const;
/** Default org for installation selection, added if neither file sets it. */
const ORG_DEFAULT = "GITHUB_ORG=upstream-org";

/** Parse only which keys are DEFINED in an env file (never expose values). */
function definedKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const keys = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** Return the exact raw line for `key` from a file (value preserved verbatim). */
function rawLine(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith(`${key}=`)) return line;
  }
  return null;
}

function main(): void {
  if (!existsSync(ROOT_ENV)) {
    console.error(`[sync-github-app-env] root .env not found at ${ROOT_ENV} — nothing to copy.`);
    process.exit(1);
  }

  const rootKeys = definedKeys(ROOT_ENV);
  const backendKeys = definedKeys(BACKEND_ENV);
  const toAppend: string[] = [];

  for (const key of APP_KEYS) {
    if (backendKeys.has(key)) {
      console.log(`[sync-github-app-env] ${key}: already in backend/.env — kept`);
      continue;
    }
    if (!rootKeys.has(key)) {
      console.log(`[sync-github-app-env] ${key}: ABSENT from root .env — skipped`);
      continue;
    }
    const line = rawLine(ROOT_ENV, key);
    if (line) {
      toAppend.push(line);
      console.log(`[sync-github-app-env] ${key}: copied from root .env → backend/.env`);
    }
  }

  // Ensure GITHUB_ORG is set so installation selection is unambiguous.
  if (backendKeys.has("GITHUB_ORG")) {
    console.log("[sync-github-app-env] GITHUB_ORG: already in backend/.env — kept");
  } else {
    const rootOrg = rawLine(ROOT_ENV, "GITHUB_ORG");
    toAppend.push(rootOrg ?? ORG_DEFAULT);
    console.log(
      `[sync-github-app-env] GITHUB_ORG: added (${rootOrg ? "from root .env" : "default upstream-org"})`,
    );
  }

  if (toAppend.length === 0) {
    console.log("[sync-github-app-env] backend/.env already complete — no changes.");
    return;
  }

  const block = `\n# --- GitHub App creds (synced from root .env by scripts/sync-github-app-env.ts) ---\n${toAppend.join("\n")}\n`;
  appendFileSync(BACKEND_ENV, block);
  console.log(`[sync-github-app-env] appended ${toAppend.length} line(s) to backend/.env.`);
}

main();
