/**
 * Pull a single file out of a run's Daytona sandbox, size-capped. This is the
 * trust-boundary seam of the slack_upload flow: the sandbox holds no Slack
 * credentials, so the BACKEND fetches the bytes (via the Daytona SDK) and does
 * the upload. `getFileDetails` is checked BEFORE `downloadFile` so an oversized
 * file is rejected without pulling it.
 *
 * The downloader is swappable for tests (setSandboxDownloaderForTest) so the
 * tool + outbox can be exercised without a live sandbox.
 */
import { Daytona } from "@daytona/sdk";

export interface SandboxFile {
  bytes: Buffer;
  size: number;
}

export type SandboxDownloader = (sandboxId: string, path: string, maxBytes: number) => Promise<SandboxFile>;

async function daytonaDownload(sandboxId: string, path: string, maxBytes: number): Promise<SandboxFile> {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) throw new Error("DAYTONA_API_KEY is not set");
  const daytona = new Daytona({ apiKey, target: process.env.DAYTONA_TARGET ?? "us" });
  const sandbox = await daytona.get(sandboxId);
  const info = await sandbox.fs.getFileDetails(path);
  const declared = Number((info as { size?: number }).size ?? 0);
  if (declared > maxBytes) {
    throw new Error(`file is ${declared} bytes, over the ${maxBytes}-byte limit`);
  }
  const bytes = await sandbox.fs.downloadFile(path);
  // Re-check post-download (Slack sources do the same: a declared size can lie).
  if (bytes.length > maxBytes) {
    throw new Error(`file is ${bytes.length} bytes, over the ${maxBytes}-byte limit`);
  }
  return { bytes, size: bytes.length };
}

let override: SandboxDownloader | null = null;

/** TEST ONLY: swap in a fake downloader so no live sandbox is needed. */
export function setSandboxDownloaderForTest(fn: SandboxDownloader | null): void {
  override = fn;
}

/** Download `path` from `sandboxId`, rejecting anything over `maxBytes`. */
export function downloadSandboxFile(sandboxId: string, path: string, maxBytes: number): Promise<SandboxFile> {
  return (override ?? daytonaDownload)(sandboxId, path, maxBytes);
}
