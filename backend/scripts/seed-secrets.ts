/**
 * Seed org secrets from local credential files (task #100).
 *
 * Reads one or more env-format (`KEY=VALUE`) OR JSON files and upserts each entry
 * into the org secret store via the same encrypt-at-rest path the API uses.
 * Idempotent - a re-run upserts (created vs updated is reported).
 *
 * ABSOLUTE RULE: a secret VALUE is NEVER printed, logged, or echoed. Output is
 * names, kinds, counts, and malformed line numbers only.
 *
 * Usage:
 *   bun run scripts/seed-secrets.ts <file> [<file> ...]
 *   SECRETS_SEED_FILE=/path/a.env,/path/b.json bun run scripts/seed-secrets.ts
 *
 * Env:
 *   SEED_ORG_ID              target org (default: the dev org, org-useAgent-dev)
 *   SECRETS_SEED_FILE        comma-separated file list (if no CLI args)
 *   SECRETS_SEED_DRYRUN=1    parse + classify + report, but write NOTHING
 *   SECRETS_EXPECTED_NAMES   a file of expected names (one per line or comma-sep);
 *                            after seeding, report which are still missing.
 *
 * JSON shape: an object of name->value, or an object with an `application_secrets`
 * object. A string value is env-kind unless it looks file-shaped (JSON blob, PEM,
 * or a long base64 blob); an object/array value is always file-kind (stringified).
 */
import { readFileSync } from "node:fs";
import type { SecretKind } from "../src/db/schema";
import { isValidSecretName } from "../src/secrets/crypto";
import { classifyKind, parseText, type ParseResult } from "../src/secrets/seed-parse";
import { listSecretMeta, upsertSecret } from "../src/secrets/store";
import { getDevContext } from "../src/seed";

const ORG_ID = process.env.SEED_ORG_ID?.trim() || getDevContext().orgId;
const DRY_RUN =
  process.env.SECRETS_SEED_DRYRUN === "1" || process.env.SECRETS_SEED_DRYRUN === "true";

function parseFile(path: string): ParseResult {
  const text = readFileSync(path, "utf8");
  return parseText(text, path.toLowerCase().endsWith(".json"));
}

async function main(): Promise<void> {
  const files = (
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : (process.env.SECRETS_SEED_FILE ?? "").split(",")
  )
    .map((f) => f.trim())
    .filter(Boolean);

  if (files.length === 0) {
    console.error("[seed-secrets] no seed files. Pass paths as args or set SECRETS_SEED_FILE.");
    process.exit(1);
  }

  console.log(`[seed-secrets] org=${ORG_ID}${DRY_RUN ? " (DRY RUN - writing nothing)" : ""}`);

  const existing = new Set((await listSecretMeta(ORG_ID)).map((s) => s.name));
  const seen = new Set<string>();
  let created = 0;
  let updated = 0;
  let skippedInvalid = 0;
  let skippedDup = 0;
  const kinds: Record<SecretKind, number> = { env: 0, file: 0 };
  const renamed: string[] = [];
  const seededNames: string[] = [];

  for (const path of files) {
    let parsed: ParseResult;
    try {
      parsed = parseFile(path);
    } catch (err) {
      console.error(`[seed-secrets] SKIP file ${path}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    console.log(
      `[seed-secrets] ${path}: ${parsed.format}, ${parsed.entries.length} entries` +
        (parsed.malformed.length
          ? `, ${parsed.malformed.length} malformed line(s): ${parsed.malformed.join(", ")}`
          : ""),
    );

    for (const e of parsed.entries) {
      if (!isValidSecretName(e.name)) {
        skippedInvalid += 1;
        // Names only - the rawKey is a KEY, never a value.
        console.warn(`[seed-secrets]   skip invalid name from key "${e.rawKey}" -> "${e.name}"`);
        continue;
      }
      if (e.name !== e.rawKey) renamed.push(`${e.rawKey} -> ${e.name}`);
      if (seen.has(e.name)) {
        skippedDup += 1;
        console.warn(`[seed-secrets]   skip duplicate name "${e.name}" (already seeded this run)`);
        continue;
      }
      seen.add(e.name);
      const kind = classifyKind(e.value, e.forceFile);
      kinds[kind] += 1;
      seededNames.push(e.name);
      const isNew = !existing.has(e.name);
      if (!DRY_RUN) {
        await upsertSecret(ORG_ID, e.name, e.value, kind);
      }
      if (isNew) created += 1;
      else updated += 1;
    }
  }

  if (renamed.length) {
    console.log(`[seed-secrets] normalized ${renamed.length} name(s): ${renamed.join(", ")}`);
  }
  console.log(`[seed-secrets] kinds: env=${kinds.env}, file=${kinds.file}`);
  console.log(
    `[seed-secrets] result: created=${created}, updated=${updated}, ` +
      `skipped_invalid=${skippedInvalid}, skipped_duplicate=${skippedDup}` +
      (DRY_RUN ? " (dry run - nothing written)" : ""),
  );
  console.log(`[seed-secrets] names now seeded: ${seededNames.sort().join(", ") || "(none)"}`);

  // Reconciliation: report expected names with no value in any source.
  const expectedFile = process.env.SECRETS_EXPECTED_NAMES?.trim();
  if (expectedFile) {
    try {
      const raw = readFileSync(expectedFile, "utf8");
      const expected = raw
        .split(/[\r\n,]+/)
        .map((n) => n.trim())
        .filter(Boolean);
      const present = new Set([...existing, ...seededNames]);
      const missing = expected.filter((n) => !present.has(n));
      console.log(`[seed-secrets] reconciliation vs ${expected.length} expected name(s):`);
      console.log(`[seed-secrets]   still missing (${missing.length}): ${missing.join(", ") || "(none)"}`);
    } catch (err) {
      console.error(
        `[seed-secrets] could not read SECRETS_EXPECTED_NAMES: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // The store client keeps the process alive; exit explicitly.
  process.exit(0);
}

await main();
