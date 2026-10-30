// A markdown source document shows the FORMATTED document in the Rendered view
// (no raw "##" or backticks) and the editable raw source in the Code view. A
// non-markdown source document keeps the plain editable surface in both.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkpieceEditorController } from "./artifact-editor-state";
import { WorkpieceSurfaces } from "./artifact-editor-surfaces";

const SOURCE = "## Pull requests\n\n**bold** text and `code`\n\n- item one";

function editor(overrides: Partial<WorkpieceEditorController>): WorkpieceEditorController {
  return {
    artifactId: "a1",
    pdfEmbed: false,
    isMarkdown: false,
    isRich: false,
    isSheetGrid: false,
    isSlidesEditor: false,
    label: "Document source",
    loading: false,
    value: SOURCE,
    sizeBytes: 10,
    pdfPreviewUrl: "",
    canonicalSource: () => SOURCE,
    setSource: () => {},
    ...overrides,
  } as unknown as WorkpieceEditorController;
}

describe("markdown workpiece surfaces", () => {
  test("Rendered view formats markdown instead of showing the raw source", () => {
    const html = renderToStaticMarkup(
      <WorkpieceSurfaces editor={editor({ isMarkdown: true })} viewMode="rendered" />,
    );
    // The heading and emphasis are real elements, not literal markers.
    expect(html).toContain("Pull requests");
    expect(html).toContain("<strong>");
    expect(html).not.toContain("## Pull requests");
    expect(html).not.toContain("**bold**");
    // It is a read-only preview, not the editable textarea.
    expect(html).not.toContain("<textarea");
    expect(html).toContain("Switch to Code to edit");
  });

  test("Code view holds the editable raw markdown source", () => {
    const html = renderToStaticMarkup(
      <WorkpieceSurfaces editor={editor({ isMarkdown: true })} viewMode="code" />,
    );
    expect(html).toContain("<textarea");
    expect(html).toContain("## Pull requests");
  });

  test("a non-markdown source document keeps the plain editable surface", () => {
    const html = renderToStaticMarkup(
      <WorkpieceSurfaces editor={editor({ isMarkdown: false })} viewMode="rendered" />,
    );
    expect(html).toContain("<textarea");
    expect(html).toContain("## Pull requests");
  });
});
