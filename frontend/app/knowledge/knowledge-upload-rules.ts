import type { IngestResult } from "./knowledge-api";

/**
 * Pure rules for the Knowledge file drop: what is accepted, the size cap, and
 * the copy shown under the control for each outcome. Mirrors the backend
 * (backend/src/knowledge/extract-text.ts) so a refusal is explained before the
 * bytes leave the browser.
 */

export const KNOWLEDGE_UPLOAD_EXTENSIONS = ["md", "txt", "pdf"] as const;
export const KNOWLEDGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const KNOWLEDGE_UPLOAD_ACCEPT = KNOWLEDGE_UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",");
export const KNOWLEDGE_UPLOAD_HINT =
  "Markdown, text or PDF, up to 10 MB each. PDFs need real text; scanned pages are not read.";

/** Copy explaining why a file will not be sent, or null when it can go. */
export function validateKnowledgeUpload(file: Pick<File, "name" | "size">): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!(KNOWLEDGE_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) {
    return `${file.name}: only .md, .txt and .pdf files can be added`;
  }
  if (file.size <= 0) return `${file.name}: the file is empty`;
  if (file.size > KNOWLEDGE_UPLOAD_MAX_BYTES) {
    return `${file.name}: larger than 10 MB`;
  }
  return null;
}

export type UploadOutcome =
  | { readonly phase: "sending" }
  | { readonly phase: "done"; readonly result: IngestResult }
  | { readonly phase: "failed"; readonly code: string | null };

/** One honest line per file. Non-storing ingest outcomes are named, never
 *  shown as a save; a backend refusal maps its code to plain copy. */
export function uploadOutcomeCopy(name: string, outcome: UploadOutcome): string {
  if (outcome.phase === "sending") return `${name}: extracting and distilling…`;
  if (outcome.phase === "done") {
    switch (outcome.result.status) {
      case "stored":
        return `${name}: added`;
      case "skipped":
        return `${name}: already in Knowledge`;
      case "dropped":
        return `${name}: useAgent judged this not worth saving`;
      case "deferred":
        return `${name}: distillation is unavailable right now, nothing was saved. Try again later.`;
    }
  }
  switch (outcome.code) {
    case "unsupported_type":
      return `${name}: only .md, .txt and .pdf files can be added`;
    case "file_too_large":
      return `${name}: larger than 10 MB`;
    case "empty_document":
      return `${name}: no text to add (scanned PDFs are not read)`;
    case "unreadable_document":
      return `${name}: could not read this file`;
    default:
      return `${name}: could not reach useAgent, try again`;
  }
}
