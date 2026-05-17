import { reclaimUnreferencedLocalArtifacts } from "./reclaim";

export interface ArtifactReclaimCliOptions {
  readonly dryRun: boolean;
  readonly minAgeMs: number;
}

export function parseArtifactReclaimArgs(args: readonly string[]): ArtifactReclaimCliOptions {
  let dryRun = false;
  let minAgeMs = 24 * 60 * 60 * 1000;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--min-age-hours") {
      const value = Number(args[index + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("--min-age-hours must be a non-negative number");
      }
      minAgeMs = value * 60 * 60 * 1000;
      index += 1;
      continue;
    }
    throw new Error(`unknown artifact reclaim argument: ${arg}`);
  }

  return { dryRun, minAgeMs };
}

export async function runArtifactReclaimCli(
  args: readonly string[] = process.argv.slice(2),
  write: (line: string) => void = console.log,
  reclaim: typeof reclaimUnreferencedLocalArtifacts = reclaimUnreferencedLocalArtifacts,
): Promise<void> {
  const options = parseArtifactReclaimArgs(args);
  const result = await reclaim(options);
  write(
    JSON.stringify({
      dry_run: options.dryRun,
      scanned: result.scanned,
      removed_count: result.removed.length,
      removed: result.removed,
      retained_count: result.retained.length,
    }),
  );
}

if (import.meta.main) {
  await runArtifactReclaimCli();
}
