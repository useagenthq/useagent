import { describe, expect, test } from "bun:test";
import {
  coerceDocument,
  coerceDocumentState,
  DEFAULT_DOCUMENT_THEME,
  documentToHtml,
  DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_THEME_PRESETS,
  isArtifactWorkpieceState,
  migrateHtmlToDocument,
  normalizeDocument,
  normalizeDocumentTheme,
  type DocumentTheme,
  type ThemedDocument,
} from "../src";

// A control character the validator must reject in any text field.
const BELL = String.fromCharCode(7);

const CUSTOM_THEME: DocumentTheme = {
  background: { type: "color", color: "#101020" },
  heading: "#f5f5ff",
  body: "#c8c8e0",
  accent: "#ff8844",
};

describe("themed-document v1 -> v2 migration", () => {
  test("migration is deterministic and produces a valid canonical document", () => {
    const html = "<h1>Title</h1><p>Body <strong>text</strong></p>";
    const a = migrateHtmlToDocument(html);
    const b = migrateHtmlToDocument(html);
    expect(a).toEqual(b);
    expect(a?.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(a?.theme).toEqual(DEFAULT_DOCUMENT_THEME);
    expect(a?.html).toBe(html);
    // The canonical `{ document }` state passes the shared type guard.
    expect(isArtifactWorkpieceState("document", { document: a })).toBe(true);
  });

  test("migration carries a supplied theme and validates it", () => {
    const doc = migrateHtmlToDocument("<p>hello</p>", CUSTOM_THEME);
    expect(doc?.theme).toEqual(CUSTOM_THEME);
  });

  test("migration fails closed on an unsafe body", () => {
    expect(migrateHtmlToDocument("<script>alert(1)</script>")).toBeNull();
  });

  test("downgrade drops the theme but the content survives", () => {
    const doc = migrateHtmlToDocument("<h1>Kept</h1><p>All of it</p>", CUSTOM_THEME);
    expect(doc).not.toBeNull();
    expect(documentToHtml(doc!)).toBe("<h1>Kept</h1><p>All of it</p>");
  });
});

describe("themed-document validation (fails closed)", () => {
  test("normalizeDocument accepts a well-formed themed document", () => {
    const doc: ThemedDocument = {
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      theme: CUSTOM_THEME,
      html: "<p>ok</p>",
    };
    expect(normalizeDocument(doc)).toEqual(doc);
  });

  test("rejects a wrong schema version, bad theme, control chars, and unsafe tags", () => {
    expect(normalizeDocument({ schemaVersion: 1, theme: CUSTOM_THEME, html: "<p>x</p>" })).toBeNull();
    expect(
      normalizeDocument({ schemaVersion: 2, theme: { ...CUSTOM_THEME, heading: "red" }, html: "<p>x</p>" }),
    ).toBeNull();
    expect(
      normalizeDocument({ schemaVersion: 2, theme: CUSTOM_THEME, html: `<p>${BELL}</p>` }),
    ).toBeNull();
    expect(
      normalizeDocument({ schemaVersion: 2, theme: CUSTOM_THEME, html: "<iframe></iframe>" }),
    ).toBeNull();
  });

  test("normalizeDocumentTheme validates hex colors and the background union", () => {
    expect(normalizeDocumentTheme(CUSTOM_THEME)).toEqual(CUSTOM_THEME);
    expect(normalizeDocumentTheme({ ...CUSTOM_THEME, background: { type: "color", color: "nope" } }))
      .toBeNull();
    const gradient: DocumentTheme = {
      background: { type: "gradient", from: "#111111", to: "#222222", angle: 90 },
      heading: "#ffffff",
      body: "#dddddd",
      accent: "#00ff00",
    };
    expect(normalizeDocumentTheme(gradient)).toEqual(gradient);
  });

  test("the presets are the shared deck presets and are valid document themes", () => {
    expect(DOCUMENT_THEME_PRESETS.length).toBeGreaterThan(0);
    for (const preset of DOCUMENT_THEME_PRESETS) {
      expect(normalizeDocumentTheme(preset.theme)).toEqual(preset.theme);
    }
  });
});

describe("coerceDocumentState (single upgrade-on-load funnel)", () => {
  test("upgrades a v1 { html } companion into a themed { document }", () => {
    const state = coerceDocumentState({ html: "<p>legacy</p>" });
    expect(state).toEqual({
      document: { schemaVersion: DOCUMENT_SCHEMA_VERSION, theme: DEFAULT_DOCUMENT_THEME, html: "<p>legacy</p>" },
    });
  });

  test("validates a v2 { document } and a bare document", () => {
    const doc = migrateHtmlToDocument("<p>x</p>", CUSTOM_THEME)!;
    expect(coerceDocumentState({ document: doc })).toEqual({ document: doc });
    expect(coerceDocument(doc)).toEqual(doc);
  });

  test("preserves a plain-text { text } source document untouched (no theme)", () => {
    expect(coerceDocumentState({ text: "# Markdown\n" })).toEqual({ text: "# Markdown\n" });
  });

  test("fails closed on garbage and on an unsafe html body", () => {
    expect(coerceDocumentState(null)).toBeNull();
    expect(coerceDocumentState({})).toBeNull();
    expect(coerceDocumentState({ html: "<script>x</script>" })).toBeNull();
    expect(coerceDocumentState({ text: `bad${BELL}text` })).toBeNull();
  });
});
