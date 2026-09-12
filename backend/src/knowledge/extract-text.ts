import { extractText } from "unpdf";

/**
 * Document text extraction for Knowledge uploads. Markdown and plain text are
 * taken as-is; PDFs go through unpdf (pdf.js packaged for server runtimes, no
 * native dependency), which reads embedded text only: a scanned PDF has none
 * and is reported as empty rather than stored as a blank record.
 */

export const KNOWLEDGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const KNOWLEDGE_UPLOAD_EXTENSIONS = ["md", "txt", "pdf"] as const;
export type KnowledgeUploadExtension = (typeof KNOWLEDGE_UPLOAD_EXTENSIONS)[number];

export type DocumentExtractionErrorCode =
  | "unsupported_type"
  | "empty_document"
  | "unreadable_document";

export class DocumentExtractionError extends Error {
  constructor(
    readonly code: DocumentExtractionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

export interface ExtractedDocument {
  readonly text: string;
  /** Page count for PDFs; null for plain text formats. */
  readonly pages: number | null;
}

export function knowledgeUploadExtension(name: string): KnowledgeUploadExtension | null {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return (KNOWLEDGE_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)
    ? (extension as KnowledgeUploadExtension)
    : null;
}

/** Collapse runs of blank lines and trailing spaces; keep paragraph breaks. */
function tidy(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replaceAll("\r\n", "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractDocumentText(
  name: string,
  bytes: Uint8Array,
): Promise<ExtractedDocument> {
  const extension = knowledgeUploadExtension(name);
  if (!extension) {
    throw new DocumentExtractionError(
      "unsupported_type",
      `Only ${KNOWLEDGE_UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(", ")} files can be added`,
    );
  }
  let text: string;
  let pages: number | null = null;
  if (extension === "pdf") {
    try {
      // pdf.js takes ownership of (detaches) the buffer it is handed; extract
      // from a copy so the caller's bytes stay usable for hashing and storage.
      const result = await extractText(bytes.slice(), { mergePages: true });
      text = tidy(result.text);
      pages = result.totalPages;
    } catch (error) {
      throw new DocumentExtractionError(
        "unreadable_document",
        `Could not read this PDF: ${(error as Error).message}`,
      );
    }
  } else {
    text = tidy(new TextDecoder("utf-8").decode(bytes));
  }
  if (!text) {
    throw new DocumentExtractionError(
      "empty_document",
      extension === "pdf"
        ? "This PDF has no extractable text (scanned pages are not read)"
        : "This file is empty",
    );
  }
  return { text, pages };
}
