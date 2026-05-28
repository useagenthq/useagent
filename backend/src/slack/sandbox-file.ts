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
import { sandboxProvider, sandboxProviderApiKey } from "../sandboxes/provider";

export interface SandboxFile {
  bytes: Buffer;
  size: number;
}

export type SandboxDownloader = (sandboxId: string, path: string, maxBytes: number) => Promise<SandboxFile>;
export type SandboxPathResolver = (sandboxId: string, path: string) => Promise<string>;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function providerResolvePath(sandboxId: string, path: string): Promise<string> {
  const apiKey = sandboxProviderApiKey();
  if (apiKey === undefined) throw new Error("sandbox provider credentials are not set");
  const provider = sandboxProvider(apiKey);
  const sandbox = await provider.get(sandboxId);
  const result = await sandbox.process.executeCommand(`realpath -e -- ${shellQuote(path)}`);
  const resolved = result.result?.replace(/\r?\n$/, "") ?? "";
  if ((result.exitCode ?? 1) !== 0 || !resolved.startsWith("/")) {
    throw new Error("artifact path does not resolve to a sandbox file");
  }
  return resolved;
}

async function providerDownload(sandboxId: string, path: string, maxBytes: number): Promise<SandboxFile> {
  const apiKey = sandboxProviderApiKey();
  if (apiKey === undefined) throw new Error("sandbox provider credentials are not set");
  const provider = sandboxProvider(apiKey);
  const sandbox = await provider.get(sandboxId);
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
let resolverOverride: SandboxPathResolver | null = null;

/** TEST ONLY: swap in a fake downloader so no live sandbox is needed. */
export function setSandboxDownloaderForTest(fn: SandboxDownloader | null): void {
  override = fn;
}

/** TEST ONLY: swap in a fake realpath resolver so no live sandbox is needed. */
export function setSandboxPathResolverForTest(fn: SandboxPathResolver | null): void {
  resolverOverride = fn;
}

/** Resolve the actual sandbox target before crossing the file-download boundary. */
export function resolveSandboxFilePath(sandboxId: string, path: string): Promise<string> {
  if (resolverOverride) return resolverOverride(sandboxId, path);
  // Downloader overrides are test-only and historically did not require a live
  // sandbox. Preserve that seam unless a test installs an explicit resolver.
  if (override) return Promise.resolve(path);
  return providerResolvePath(sandboxId, path);
}

/** Download `path` from `sandboxId`, rejecting anything over `maxBytes`. */
export function downloadSandboxFile(sandboxId: string, path: string, maxBytes: number): Promise<SandboxFile> {
  return (override ?? providerDownload)(sandboxId, path, maxBytes);
}
