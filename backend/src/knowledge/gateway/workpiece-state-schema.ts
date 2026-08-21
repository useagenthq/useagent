import {
  DOCUMENT_SCHEMA_VERSION,
  PRESENTATION_SCHEMA_VERSION,
  SPREADSHEET_SCHEMA_VERSION,
} from "@skynet/artifact-workspace";

const HEX_COLOR_PATTERN = "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$";

const hexColorSchema = {
  type: "string",
  pattern: HEX_COLOR_PATTERN,
  description: "Hex color, e.g. #fff, #ffffff, or #ffffffff.",
} as const;

const deckBackgroundSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["color"] },
        color: hexColorSchema,
      },
      required: ["type", "color"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["gradient"] },
        from: hexColorSchema,
        to: hexColorSchema,
        angle: {
          type: "number",
          minimum: 0,
          maximum: 360,
          description: "Gradient angle in degrees.",
        },
      },
      required: ["type", "from", "to"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { type: "string", enum: ["image"] },
        url: {
          type: "string",
          description: "Same-origin path or HTTPS URL for a published image artifact.",
        },
      },
      required: ["type", "url"],
      additionalProperties: false,
    },
  ],
} as const;

const deckThemeSchema = {
  type: "object",
  properties: {
    background: deckBackgroundSchema,
    heading: hexColorSchema,
    body: hexColorSchema,
    accent: hexColorSchema,
  },
  required: ["background", "heading", "body", "accent"],
  additionalProperties: false,
} as const;

const deckBlockCoordinateSchema = {
  type: "number",
  minimum: 0,
  maximum: 100,
  description: "Percent of the 16:9 reference canvas, from 0 to 100.",
} as const;

const deckBlockStyleSchema = {
  type: "object",
  properties: {
    color: hexColorSchema,
    fontSize: {
      type: "number",
      minimum: 4,
      maximum: 400,
      description: "Font size in px on the 1080px-tall reference canvas.",
    },
    bold: { type: "boolean" },
    italic: { type: "boolean" },
    align: { type: "string", enum: ["left", "center", "right"] },
    fill: hexColorSchema,
    radius: {
      type: "number",
      minimum: 0,
      maximum: 400,
      description: "Shape corner radius in px on the reference canvas.",
    },
  },
  additionalProperties: false,
} as const;

const deckBlockSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: ["heading", "text", "image", "shape"] },
    x: deckBlockCoordinateSchema,
    y: deckBlockCoordinateSchema,
    w: deckBlockCoordinateSchema,
    h: deckBlockCoordinateSchema,
    content: {
      type: "string",
      description: "heading/text: text; image: artifact image URL; shape: usually empty string.",
    },
    style: deckBlockStyleSchema,
  },
  required: ["id", "type", "x", "y", "w", "h", "content"],
  additionalProperties: false,
} as const;

const deckSlideSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    blocks: {
      type: "array",
      items: deckBlockSchema,
      description: "Positioned deck blocks. Coordinates are percentages, not pixels.",
    },
    background: deckBackgroundSchema,
    notes: { type: "string" },
  },
  required: ["id", "blocks"],
  additionalProperties: false,
} as const;

const presentationDeckSchema = {
  type: "object",
  properties: {
    schemaVersion: { type: "number", enum: [PRESENTATION_SCHEMA_VERSION] },
    theme: deckThemeSchema,
    slides: {
      type: "array",
      items: deckSlideSchema,
    },
  },
  required: ["schemaVersion", "theme", "slides"],
  additionalProperties: false,
} as const;

const presentationStateSchema = {
  type: "object",
  properties: {
    deck: presentationDeckSchema,
  },
  required: ["deck"],
  additionalProperties: false,
} as const;

const legacyPresentationSlidesStateSchema = {
  type: "object",
  properties: {
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          notes: { type: "string" },
        },
        required: ["title", "body"],
        additionalProperties: false,
      },
      description: "Legacy title/body slides; upgraded to a canonical deck on write.",
    },
  },
  required: ["slides"],
  additionalProperties: false,
} as const;

const documentStateSchema = {
  type: "object",
  properties: {
    document: {
      type: "object",
      properties: {
        schemaVersion: { type: "number", enum: [DOCUMENT_SCHEMA_VERSION] },
        theme: deckThemeSchema,
        html: { type: "string" },
      },
      required: ["schemaVersion", "theme", "html"],
      additionalProperties: false,
    },
  },
  required: ["document"],
  additionalProperties: false,
} as const;

const htmlDocumentStateSchema = {
  type: "object",
  properties: {
    html: {
      type: "string",
      description: "Legacy rich HTML document body; upgraded to a themed document on write.",
    },
  },
  required: ["html"],
  additionalProperties: false,
} as const;

const textDocumentStateSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
  },
  required: ["text"],
  additionalProperties: false,
} as const;

const sheetCellSchema = {
  type: "object",
  properties: {
    v: { anyOf: [{ type: "string" }, { type: "number" }] },
    f: { type: "string", description: "Formula beginning with =." },
    fmt: {
      type: "object",
      properties: {
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        align: { type: "string", enum: ["left", "center", "right"] },
        numFmt: { type: "string", enum: ["auto", "currency", "percent", "0", "0.00"] },
        fill: hexColorSchema,
        color: hexColorSchema,
      },
      additionalProperties: false,
    },
  },
  required: ["v"],
  additionalProperties: false,
} as const;

const workbookStateSchema = {
  type: "object",
  properties: {
    workbook: {
      type: "object",
      properties: {
        schemaVersion: { type: "number", enum: [SPREADSHEET_SCHEMA_VERSION] },
        activeSheetId: { type: "string" },
        sheets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              cells: {
                type: "object",
                additionalProperties: sheetCellSchema,
                description: "Sparse cells keyed by A1 reference.",
              },
              colWidths: {
                type: "object",
                additionalProperties: { type: "number" },
              },
              rowCount: { type: "number" },
              colCount: { type: "number" },
            },
            required: ["id", "name", "cells", "rowCount", "colCount"],
            additionalProperties: false,
          },
        },
      },
      required: ["schemaVersion", "activeSheetId", "sheets"],
      additionalProperties: false,
    },
  },
  required: ["workbook"],
  additionalProperties: false,
} as const;

const csvSpreadsheetStateSchema = {
  type: "object",
  properties: {
    csv: {
      type: "string",
      description: "Legacy CSV spreadsheet source; upgraded to a workbook on write.",
    },
  },
  required: ["csv"],
  additionalProperties: false,
} as const;

const pdfTextStateSchema = {
  type: "object",
  properties: {
    pdfText: { type: "string" },
  },
  required: ["pdfText"],
  additionalProperties: false,
} as const;

export const WORKPIECE_STATE_INPUT_SCHEMA = {
  anyOf: [
    documentStateSchema,
    htmlDocumentStateSchema,
    textDocumentStateSchema,
    workbookStateSchema,
    csvSpreadsheetStateSchema,
    presentationStateSchema,
    legacyPresentationSlidesStateSchema,
    pdfTextStateSchema,
  ],
  description:
    "Full replacement workpiece state. Prefer canonical v2 states: document {document}, " +
    "spreadsheet {workbook}, presentation {deck}, pdf {pdfText}. Legacy shorthands " +
    "{html}, {text}, {csv}, and {slides} are accepted and upgraded on write.",
} as const;
