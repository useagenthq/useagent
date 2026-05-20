import {
  artifactFileExtension,
  DOCX_CONTENT_TYPE,
  isArtifactWorkpieceState,
  MAX_WORKPIECE_STATE_BYTES as ARTIFACT_MAX_WORKPIECE_STATE_BYTES,
  normalizeArtifactRichHtml,
  normalizeArtifactContentType,
  PDF_CONTENT_TYPE,
  PPTX_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  type ArtifactWorkpieceKind,
  type ArtifactWorkpieceState,
} from "@skynet/artifact-workspace";

export {
  inferWorkpieceKind,
  MAX_RICH_WORKPIECE_SOURCE_BYTES,
  MAX_WORKPIECE_STATE_BYTES,
} from "@skynet/artifact-workspace";

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parsePresentationSlides(value: string): ArtifactWorkpieceState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const slides = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "slides" in parsed
    ? (parsed as { readonly slides: unknown }).slides
    : null;
  return parseWorkpieceState("presentation", { slides });
}

export function parseWorkpieceState(
  kind: ArtifactWorkpieceKind,
  value: unknown,
): ArtifactWorkpieceState | null {
  if (!isArtifactWorkpieceState(kind, value)) return null;
  let state: ArtifactWorkpieceState = value;
  if ("html" in value) {
    const html = normalizeArtifactRichHtml(value.html);
    if (html === null) return null;
    state = { html };
  }
  if ("slides" in value) {
    const hasUnsafeText = value.slides.some((slide) =>
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(
        `${slide.title}${slide.body}${slide.notes ?? ""}`,
      )
    );
    if (hasUnsafeText) return null;
  }
  return new TextEncoder().encode(JSON.stringify(state)).byteLength <=
    ARTIFACT_MAX_WORKPIECE_STATE_BYTES
    ? state
    : null;
}

/** Build the first browser-editable revision without interpreting Office
 * container bytes in the control plane. Text and CSV files seed themselves;
 * Office files require a small, explicit companion produced in the same
 * sandbox. The original artifact remains immutable in either case. */
export function buildInitialWorkpieceState(input: {
  readonly kind: ArtifactWorkpieceKind;
  readonly sourceName: string;
  readonly sourceContentType?: string;
  readonly sourceBytes: Uint8Array;
  readonly editable?: {
    readonly name: string;
    readonly bytes: Uint8Array;
  };
}): ArtifactWorkpieceState | null {
  const sourceSuffix = artifactFileExtension(input.sourceName);
  const sourceMime = normalizeArtifactContentType(input.sourceContentType ?? "");
  const officeDocument = sourceSuffix === "docx" || sourceMime === DOCX_CONTENT_TYPE;
  const officeSpreadsheet = sourceSuffix === "xlsx" || sourceMime === XLSX_CONTENT_TYPE;
  const officePresentation = sourceSuffix === "pptx" || sourceMime === PPTX_CONTENT_TYPE;
  const pdf = sourceSuffix === "pdf" || sourceMime === PDF_CONTENT_TYPE;

  const editableText = input.editable ? decodeUtf8(input.editable.bytes) : null;
  if (input.kind === "spreadsheet") {
    if (officeSpreadsheet) {
      if (artifactFileExtension(input.editable?.name ?? "") !== "csv" || editableText === null) {
        return null;
      }
      return parseWorkpieceState("spreadsheet", { csv: editableText });
    }
    const sourceText = decodeUtf8(input.sourceBytes);
    return sourceText === null ? null : parseWorkpieceState("spreadsheet", { csv: sourceText });
  }

  if (input.kind === "presentation") {
    if (officePresentation) {
      if (artifactFileExtension(input.editable?.name ?? "") !== "json" || editableText === null) {
        return null;
      }
      return parsePresentationSlides(editableText);
    }
    return parseWorkpieceState("presentation", {
      slides: [{ title: input.sourceName.replace(/\.[^.]+$/, ""), body: "", notes: "" }],
    });
  }

  if (input.kind === "pdf") {
    if (pdf) {
      if (artifactFileExtension(input.editable?.name ?? "") !== "txt" || editableText === null) {
        return null;
      }
      return parseWorkpieceState("pdf", { pdfText: editableText });
    }
    const sourceText = decodeUtf8(input.sourceBytes);
    return sourceText === null ? null : parseWorkpieceState("pdf", { pdfText: sourceText });
  }

  if (officeDocument) {
    if (artifactFileExtension(input.editable?.name ?? "") !== "html" || editableText === null) {
      return null;
    }
    return parseWorkpieceState("document", { html: editableText });
  }
  const sourceText = decodeUtf8(input.sourceBytes);
  return sourceText === null ? null : parseWorkpieceState("document", { text: sourceText });
}
