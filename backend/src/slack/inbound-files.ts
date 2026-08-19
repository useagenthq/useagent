/**
 * Inbound Slack attachments (user -> bot). When an inbound message carries
 * files, the backend downloads them BOUNDED (count + size caps, Slack-hosted
 * URLs only, bot-token auth) and persists them through the shared uploads lane
 * (uploads/ingest.ts: scan + content-addressed bytes + a claimable
 * user_uploads row). The returned upload ids ride the run.create command as
 * `attachmentIds`, so the run claims them atomically and the engine
 * materializes them into the sandbox exactly like a browser upload.
 *
 * Per-file failures (oversized, off-host URL, scan rejection, network error)
 * SKIP that file with a log - a bad attachment never blocks the run.
 *
 * The downloader is swappable for tests (setInboundFileDownloaderForTest),
 * mirroring sandbox-file.ts, so no test touches Slack's CDN.
 */
import { ingestUserUpload } from "../uploads/ingest";
import { validateUploadName } from "../uploads/routes";
import { UploadScanError } from "../uploads/scan";

export const MAX_INBOUND_SLACK_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_INBOUND_SLACK_FILES = 5;

/** The subset of Slack's file object the ingest needs (events API `files[]`). */
export interface SlackInboundFileMeta {
  id?: string;
  name?: string;
  size?: number;
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
}

export type InboundFileDownloader = (url: string, botToken: string) => Promise<Uint8Array>;

/** Only Slack-hosted HTTPS URLs are fetched - the bot token must never be sent
 *  to an attacker-controlled host riding in a crafted event. */
export function isSlackFileUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return url.hostname === "slack.com" || url.hostname.endsWith(".slack.com");
}

async function fetchWithBotToken(url: string, botToken: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`slack file download failed: http_${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

let override: InboundFileDownloader | null = null;

/** TEST ONLY: swap in a fake downloader so no request hits Slack's CDN. */
export function setInboundFileDownloaderForTest(fn: InboundFileDownloader | null): void {
  override = fn;
}

/**
 * Download an inbound message's files (bounded) and persist each through the
 * uploads lane under the resolved workspace identity. Returns the upload ids
 * to claim as the run's attachments; skipped/failed files are logged, never
 * thrown.
 */
export async function stageInboundSlackFiles(opts: {
  files: readonly SlackInboundFileMeta[];
  botToken: string;
  orgId: string;
  userId: string;
}): Promise<string[]> {
  const download = override ?? fetchWithBotToken;
  if (opts.files.length > MAX_INBOUND_SLACK_FILES) {
    console.warn(
      `[slack] message carries ${opts.files.length} files - staging the first ${MAX_INBOUND_SLACK_FILES}`,
    );
  }
  const ids: string[] = [];
  for (const file of opts.files.slice(0, MAX_INBOUND_SLACK_FILES)) {
    const label = file.id ?? file.name ?? "(unnamed)";
    try {
      const url = file.url_private_download ?? file.url_private;
      if (!url || !isSlackFileUrl(url)) {
        console.warn(`[slack] skipping inbound file ${label}: not a Slack-hosted https url`);
        continue;
      }
      // Reject on the declared size BEFORE pulling the bytes, then re-check the
      // real length after (a declared size can lie) - sandbox-file.ts discipline.
      if (typeof file.size === "number" && file.size > MAX_INBOUND_SLACK_FILE_BYTES) {
        console.warn(
          `[slack] skipping inbound file ${label}: ${file.size} bytes exceeds the ${MAX_INBOUND_SLACK_FILE_BYTES}-byte cap`,
        );
        continue;
      }
      const bytes = await download(url, opts.botToken);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_INBOUND_SLACK_FILE_BYTES) {
        console.warn(
          `[slack] skipping inbound file ${label}: downloaded ${bytes.byteLength} bytes (cap ${MAX_INBOUND_SLACK_FILE_BYTES})`,
        );
        continue;
      }
      const name =
        validateUploadName(file.name ?? "") ?? (file.id ? `slack-file-${file.id}` : "slack-file");
      const row = await ingestUserUpload({
        orgId: opts.orgId,
        userId: opts.userId,
        name,
        suppliedContentType: file.mimetype ?? "",
        bytes,
      });
      ids.push(row.id);
    } catch (err) {
      if (err instanceof UploadScanError) {
        console.warn(`[slack] inbound file ${label} rejected by the upload scanner`);
      } else {
        console.warn(`[slack] inbound file ${label} failed to stage:`, (err as Error).message);
      }
    }
  }
  return ids;
}
