/** Private Pro paths that must never enter the public OSS repository. */
export const OSS_SYNC_EXCLUDED_PREFIXES = [
  "deploy/hetzner/",
  "infra/terraform/prod/",
] as const;

export function assertOssSyncSafe(paths: readonly string[]): void {
  const privatePaths = paths.filter((path) =>
    OSS_SYNC_EXCLUDED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))
  );
  if (privatePaths.length > 0) {
    throw new Error(`OSS sync contains private paths: ${privatePaths.join(", ")}`);
  }
}

if (import.meta.main) {
  const paths = process.argv.slice(2).map((path) => path.trim()).filter(Boolean);
  if (paths.length === 0) {
    throw new Error(
      "usage: bun scripts/assert-oss-sync-safe.ts $(git diff --name-only <base>..<head>)",
    );
  }
  assertOssSyncSafe(paths);
  console.log(`OSS_SYNC_BOUNDARY_OK files=${paths.length}`);
}
