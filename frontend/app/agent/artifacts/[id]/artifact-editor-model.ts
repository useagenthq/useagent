import type { ArtifactDescriptor, ArtifactWorkpieceResult } from "@skynet/agent-client";

export const SHEET_ROW_LIMIT = 100;
export const SHEET_COLUMN_LIMIT = 26;

const RICH_DOCUMENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const RICH_SPREADSHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const ALLOWED_RICH_TAGS = new Set([
  "A",
  "B",
  "BR",
  "DIV",
  "EM",
  "H1",
  "H2",
  "H3",
  "I",
  "LI",
  "OL",
  "P",
  "STRONG",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "U",
  "UL",
]);

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > -1 ? name.slice(dot + 1).toLowerCase() : "";
}

function mime(artifact: Pick<ArtifactDescriptor, "content_type">): string {
  return artifact.content_type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isRichDocumentArtifact(
  artifact: Pick<ArtifactDescriptor, "content_type" | "name">,
): boolean {
  return mime(artifact) === RICH_DOCUMENT_TYPE || extension(artifact.name) === "docx";
}

export function isRichSpreadsheetArtifact(
  artifact: Pick<ArtifactDescriptor, "content_type" | "name">,
): boolean {
  return mime(artifact) === RICH_SPREADSHEET_TYPE || extension(artifact.name) === "xlsx";
}

export function stateValue(result: ArtifactWorkpieceResult): string | null {
  if (!result.state) return null;
  if ("csv" in result.state) return result.state.csv;
  if ("html" in result.state) return result.state.html;
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
  return `<h1>${escapeHtml(name.replace(/\.[^.]+$/, ""))}</h1><p></p>`;
}

export function sanitizeRichHtml(value: string): string {
  if (typeof document === "undefined") return value.replace(/<[^>]*>/g, "");
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
      if (!ALLOWED_RICH_TAGS.has(element.tagName)) {
        element.replaceWith(document.createTextNode(element.textContent ?? ""));
        continue;
      }
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const text = attribute.value.trim().toLowerCase();
        if (
          name.startsWith("on") ||
          name === "style" ||
          (name !== "href" && name !== "colspan" && name !== "rowspan")
        ) {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (
          name === "href" &&
          !text.startsWith("https://") &&
          !text.startsWith("http://") &&
          !text.startsWith("mailto:")
        ) {
          element.removeAttribute(attribute.name);
        }
      }
      visit(element);
    }
  };
  visit(template.content);
  return template.innerHTML;
}

export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [[]];
  let value = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      rows[rows.length - 1]?.push(value);
      value = "";
    } else if (character === "\n") {
      rows[rows.length - 1]?.push(value);
      rows.push([]);
      value = "";
    } else if (character !== "\r") {
      value += character;
    }
  }
  rows[rows.length - 1]?.push(value);
  return rows;
}

function serializeCsvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function serializeCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(serializeCsvCell).join(",")).join("\n");
}

export function isSheetWithinGridLimit(rows: readonly (readonly string[])[]): boolean {
  return rows.length <= SHEET_ROW_LIMIT && rows.every((row) => row.length <= SHEET_COLUMN_LIMIT);
}
