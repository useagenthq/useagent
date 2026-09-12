// Bake the native image as a Box named snapshot. Box snapshots belong to the
// account whose key made them, so this bakes once per account:
//
//   bun run scripts/bake-box-snapshot.ts --connections   # every connected user Box account; stamps each connection
//   bun run scripts/bake-box-snapshot.ts --env           # the BOX_API_KEY account; set RUNTIME_BOX_SNAPSHOT to the printed name
//   bun run scripts/bake-box-snapshot.ts --check         # print the current image name
//
// `--force` replaces an existing snapshot of the current name. Runs where the
// runtime assets ship (the backend container), with the backend's env.
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { providerConnections } from "../src/db/schema";
import {
  bakeBoxNativeSnapshot,
  boxConnectionAcceptsNativeSnapshot,
  boxNativeSnapshotName,
} from "../src/engines/box-native-template";
import { getTrustedProviderCredential, rememberPreparedProviderSnapshot } from "../src/provider-connections/service";
import { sandboxProviderFor } from "../src/sandboxes/provider";

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const log = (line: string) => console.log(`[bake] ${line}`);

async function bakeConnections(): Promise<number> {
  const rows = await db
    .select()
    .from(providerConnections)
    .where(and(
      eq(providerConnections.provider, "box"),
      eq(providerConnections.status, "connected"),
      eq(providerConnections.authMethod, "api_key"),
    ));
  let failures = 0;
  const name = boxNativeSnapshotName();
  for (const row of rows) {
    const scope = { orgId: row.orgId, userId: row.userId };
    const snapshot = row.metadata?.snapshotName?.trim() || null;
    if (!boxConnectionAcceptsNativeSnapshot(snapshot)) {
      log(`${row.userId}: keeps its own snapshot ${snapshot}; skipped`);
      continue;
    }
    if (snapshot === name && !force) {
      log(`${row.userId}: already on ${name}`);
      continue;
    }
    const credential = await getTrustedProviderCredential({ ...scope, provider: "box", authMethod: "api_key" });
    if (!credential || credential.authMethod !== "api_key" || typeof credential.value !== "string") {
      log(`${row.userId}: credential unavailable; skipped`);
      continue;
    }
    try {
      const result = await bakeBoxNativeSnapshot(sandboxProviderFor("box", credential.value), {
        base: snapshot && !snapshot.startsWith("useagent-") ? snapshot : null,
        force,
        log: (line) => log(`${row.userId}: ${line}`),
      });
      const stamped = await rememberPreparedProviderSnapshot({
        ...scope,
        provider: "box",
        snapshotName: result.name,
        expectedUpdatedAt: row.updatedAt.toISOString(),
      });
      log(`${row.userId}: ${result.name} ${result.outcome}; connection ${stamped ? "now uses it" : "changed meanwhile, not stamped"}`);
    } catch (error) {
      failures += 1;
      log(`${row.userId}: failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`${rows.length} connected Box account(s), ${failures} failure(s)`);
  return failures;
}

async function bakeEnvironment(): Promise<void> {
  const apiKey = process.env.BOX_API_KEY?.trim();
  if (!apiKey) throw new Error("BOX_API_KEY is not set");
  const result = await bakeBoxNativeSnapshot(sandboxProviderFor("box", apiKey), {
    base: process.env.BOX_SNAPSHOT?.trim() || null,
    force,
    log,
  });
  log(`${result.name} ${result.outcome}. Set RUNTIME_BOX_SNAPSHOT=${result.name} for runs on this account.`);
}

try {
  if (args.has("--check")) {
    console.log(boxNativeSnapshotName());
  } else if (args.has("--connections")) {
    process.exitCode = (await bakeConnections()) === 0 ? 0 : 1;
  } else if (args.has("--env")) {
    await bakeEnvironment();
  } else {
    throw new Error("pass --connections, --env or --check");
  }
} catch (error) {
  console.error(`[bake] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
process.exit();
