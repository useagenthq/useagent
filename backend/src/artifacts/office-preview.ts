import { basename } from "node:path";
import {
  DOCX_CONTENT_TYPE,
  normalizeArtifactContentType,
  PPTX_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
} from "@skynet/artifact-workspace";
import { sandboxProvider, sandboxProviderApiKey } from "../sandboxes/provider";

/** The Office binary content types LibreOffice can render to a PDF preview. */
const OFFICE_PREVIEW_CONTENT_TYPES = new Set([
  DOCX_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  PPTX_CONTENT_TYPE,
]);

/** Bounds for the best-effort in-sandbox conversion. A preview must never dominate
 * a publish, so the soffice run is time-boxed and the resulting PDF is size-capped. */
export const OFFICE_PREVIEW_TIMEOUT_SECONDS = 30;
export const OFFICE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/** True when this content type is an Office binary a PDF preview is attempted for. */
export function isOfficePreviewContentType(contentType: string): boolean {
  return OFFICE_PREVIEW_CONTENT_TYPES.has(normalizeArtifactContentType(contentType));
}

export interface OfficePreviewInput {
  readonly sandboxId: string;
  readonly sourcePath: string;
  readonly timeoutSeconds: number;
  readonly maxBytes: number;
}

/** Convert an Office file in a sandbox to PDF bytes, or null when it cannot be
 * produced (no soffice, a non-zero exit, an oversized or empty output). Never
 * throws for a conversion failure - a missing preview is a normal outcome. */
export type OfficePreviewConverter = (input: OfficePreviewInput) => Promise<Uint8Array | null>;

/** Shell-single-quote a path so an odd filename cannot break the soffice command.
 * The path already lives in the agent's own sandbox, so this is correctness (not a
 * privilege boundary - the agent can run any command there anyway). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const PREVIEW_OUTDIR = "/tmp/skynet-office-preview";

async function providerConvert(input: OfficePreviewInput): Promise<Uint8Array | null> {
  const apiKey = sandboxProviderApiKey();
  if (apiKey === undefined) return null;
  const provider = sandboxProvider(apiKey);
  const sandbox = await provider.get(input.sandboxId);
  const stem = basename(input.sourcePath).replace(/\.[^.]+$/, "") || "preview";
  const outPath = `${PREVIEW_OUTDIR}/${stem}.pdf`;
  const command =
    `rm -rf ${shellQuote(PREVIEW_OUTDIR)} && mkdir -p ${shellQuote(PREVIEW_OUTDIR)} && ` +
    `soffice --headless --nolockcheck --convert-to pdf --outdir ${shellQuote(PREVIEW_OUTDIR)} ` +
    `${shellQuote(input.sourcePath)}`;
  const result = await sandbox.process.executeCommand(
    command,
    undefined,
    undefined,
    input.timeoutSeconds,
  );
  if ((result.exitCode ?? 1) !== 0) return null;
  const info = await sandbox.fs.getFileDetails(outPath);
  if (Number((info as { size?: number }).size ?? 0) > input.maxBytes) return null;
  const bytes = await sandbox.fs.downloadFile(outPath);
  if (bytes.length === 0 || bytes.length > input.maxBytes) return null;
  return new Uint8Array(bytes);
}

let override: OfficePreviewConverter | null = null;

/** TEST ONLY: swap in a fake converter so no live sandbox with soffice is needed. */
export function setOfficePreviewConverterForTest(fn: OfficePreviewConverter | null): void {
  override = fn;
}

/** Render an Office file in the sandbox to a PDF preview, or null on any failure
 * (best-effort; the caller treats null as "no preview, download-only as before"). */
export async function convertOfficeToPdf(input: OfficePreviewInput): Promise<Uint8Array | null> {
  try {
    return await (override ?? providerConvert)(input);
  } catch {
    return null;
  }
}
