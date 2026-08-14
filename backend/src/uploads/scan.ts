import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface UploadScanInput {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface UploadScanResult {
  readonly scanned: boolean;
}

export class UploadScanError extends Error {
  readonly code = "upload_scan_failed";

  constructor(message = "upload scanner rejected file") {
    super(message);
    this.name = "UploadScanError";
  }
}

type UploadScanner = (input: UploadScanInput) => Promise<UploadScanResult>;

let testScanner: UploadScanner | null = null;

export function setUploadScannerForTest(scanner: UploadScanner | null): void {
  testScanner = scanner;
}

function configuredCommand(): string | null {
  const command = process.env.UPLOAD_SCAN_COMMAND?.trim();
  return command ? command : null;
}

function scannerRequired(): boolean {
  const configured = process.env.UPLOAD_SCAN_REQUIRED?.trim().toLowerCase();
  if (configured !== undefined && configured !== "") {
    return configured === "1" || configured === "true";
  }
  return process.env.NODE_ENV === "production";
}

function configuredTimeoutMs(): number {
  const value = Number(process.env.UPLOAD_SCAN_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(value) || value < 1 || value > 300_000) {
    throw new UploadScanError("UPLOAD_SCAN_TIMEOUT_MS must be an integer from 1 to 300000");
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function scanWithCommand(command: string, input: UploadScanInput): Promise<UploadScanResult> {
  const directory = await mkdtemp(join(tmpdir(), "skynet-upload-scan-"));
  const path = join(directory, "upload");
  try {
    await writeFile(path, input.bytes, { mode: 0o600 });
    const quotedPath = shellQuote(path);
    const expanded = command.includes("{}")
      ? command.replaceAll("{}", quotedPath)
      : `${command} ${quotedPath}`;
    const proc = Bun.spawn(["sh", "-c", expanded], {
      detached: true,
      env: {
        ...process.env,
        SKYNET_UPLOAD_NAME: input.name,
        SKYNET_UPLOAD_CONTENT_TYPE: input.contentType,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }, configuredTimeoutMs());
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timer));
    if (timedOut) throw new UploadScanError("upload scanner timed out");
    if (exitCode !== 0) {
      throw new UploadScanError(stderr.trim() || `upload scanner exited ${exitCode}`);
    }
    return { scanned: true };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function scanUploadBytes(input: UploadScanInput): Promise<UploadScanResult> {
  if (testScanner) return testScanner(input);
  const command = configuredCommand();
  if (!command) {
    if (scannerRequired()) {
      throw new UploadScanError("upload scanner is required but UPLOAD_SCAN_COMMAND is not configured");
    }
    return { scanned: false };
  }
  return scanWithCommand(command, input);
}
