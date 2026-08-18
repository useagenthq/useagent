import type { ArtifactDescriptor, ArtifactWorkpieceResult } from "@skynet/agent-client";
import {
  artifactActionContractFor,
  artifactFileExtension,
  emptyWorkbook,
  isArtifactRichHtmlAttribute,
  isArtifactRichHtmlTag,
  migrateSlidesToDeck,
  normalizeArtifactRichHtml,
} from "@skynet/artifact-workspace";

export {
  parseArtifactCsv as parseCsv,
  serializeArtifactCsv as serializeCsv,
} from "@skynet/artifact-workspace";

export type ArtifactEditorMode =
  | "source-document"
  | "rich-document"
  | "sheet-grid"
  | "slides-json"
  | "pdf-text";

export function artifactEditorMode(
  artifact: Pick<ArtifactDescriptor, "content_type" | "name" | "size_bytes"> &
    Readonly<{
      workpiece: Pick<NonNullable<ArtifactDescriptor["workpiece"]>, "kind" | "actions"> | null;
    }>,
): ArtifactEditorMode {
  const edit = artifactActionContractFor(artifact).edit;
  if (!edit) return "source-document";
  switch (edit.state) {
    case "html":
      return "rich-document";
    case "csv":
      return "sheet-grid";
    case "slides":
      return "slides-json";
    case "pdfText":
      return "pdf-text";
    case "text":
      return "source-document";
  }
}

export function stateValue(result: ArtifactWorkpieceResult): string | null {
  if (!result.state) return null;
  if ("workbook" in result.state) return JSON.stringify(result.state.workbook, null, 2);
  // A themed document surfaces its HTML body to the editor; the theme rides
  // alongside in the controller state (see useWorkpieceEditor).
  if ("document" in result.state) return result.state.document.html;
  if ("deck" in result.state) return JSON.stringify(result.state.deck, null, 2);
  if ("pdfText" in result.state) return result.state.pdfText;
  return result.state.text;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function richDocumentTemplate(name: string): string {
  const suffix = artifactFileExtension(name);
  const stem = suffix ? name.slice(0, -(suffix.length + 1)) : name;
  return `<h1>${escapeHtml(stem)}</h1><p></p>`;
}

export function presentationTemplate(name: string): string {
  const suffix = artifactFileExtension(name);
  const stem = suffix ? name.slice(0, -(suffix.length + 1)) : name;
  return JSON.stringify(migrateSlidesToDeck([{ title: stem, body: "", notes: "" }]), null, 2);
}

export function spreadsheetTemplate(): string {
  return JSON.stringify(emptyWorkbook(), null, 2);
}

export function sanitizeRichHtml(value: string): string {
  if (typeof document === "undefined") {
    return normalizeArtifactRichHtml(value) ?? escapeHtml(value.replace(/<[^>]*>/g, ""));
  }
  const template = document.createElement("template");
  template.innerHTML = value;
  const visit = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as HTMLElement;
      if (!isArtifactRichHtmlTag(element.tagName)) {
        element.replaceWith(document.createTextNode(element.textContent ?? ""));
        continue;
      }
      for (const attribute of Array.from(element.attributes)) {
        if (!isArtifactRichHtmlAttribute(element.tagName, attribute.name, attribute.value)) {
          element.removeAttribute(attribute.name);
        }
      }
      visit(element);
    }
  };
  visit(template.content);
  return normalizeArtifactRichHtml(template.innerHTML) ??
    escapeHtml(template.content.textContent ?? "");
}
