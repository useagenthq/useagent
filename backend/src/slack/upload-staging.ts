/**
 * Server-side staging for durable Slack file uploads.
 *
 * The bytes an agent wants delivered live in the Daytona sandbox, which is torn
 * down when the run ends - but the durable outbox may deliver (and retry) AFTER
 * that, even across a restart. So the slack_upload tool pulls the file WHILE the
 * sandbox is alive and stages the bytes on the backend's disk; the outbox row
 * carries only the staged path. The relay reads the staged bytes at delivery
 * time and removes them once the row reaches a terminal state.
 *
 * Single-replica scope (matches the rest of skynet today): staging is local disk.
 */
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Sibling of the per-run workdirs (.runs/); both are gitignored.
export const STAGING_ROOT = join(import.meta.dir, "..", "..", ".slack-uploads");

/** Write bytes to a fresh staged file and return its absolute path. */
export async function stageUploadBytes(filename: string, bytes: Buffer): Promise<string> {
  await mkdir(STAGING_ROOT, { recursive: true });
  const safe = filename.replace(/[^\w.-]/g, "_").slice(-80) || "file";
  const path = join(STAGING_ROOT, `${randomUUID()}-${safe}`);
  await writeFile(path, bytes);
  return path;
}

/** Read staged bytes back for delivery. */
export function readStagedBytes(path: string): Promise<Buffer> {
  return readFile(path);
}

/** Best-effort remove a staged file. Refuses paths outside STAGING_ROOT so a
 *  malformed payload can never unlink an arbitrary file. */
export async function removeStaged(path: string): Promise<void> {
  if (!path.startsWith(STAGING_ROOT)) return;
  await unlink(path).catch(() => {});
}
