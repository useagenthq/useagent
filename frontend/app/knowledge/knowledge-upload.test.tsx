import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgeGallery } from "./knowledge-gallery";
import {
  KNOWLEDGE_UPLOAD_ACCEPT,
  KNOWLEDGE_UPLOAD_MAX_BYTES,
  uploadOutcomeCopy,
  validateKnowledgeUpload,
} from "./knowledge-upload-rules";
import { KnowledgeUploadDrop } from "./knowledge-upload";

describe("knowledge upload rules", () => {
  test("accepts md, txt and pdf under the cap and names every refusal", () => {
    expect(validateKnowledgeUpload({ name: "runbook.md", size: 10 })).toBeNull();
    expect(validateKnowledgeUpload({ name: "NOTES.TXT", size: 10 })).toBeNull();
    expect(validateKnowledgeUpload({ name: "spec.pdf", size: KNOWLEDGE_UPLOAD_MAX_BYTES })).toBeNull();
    expect(validateKnowledgeUpload({ name: "deck.pptx", size: 10 })).toBe(
      "deck.pptx: only .md, .txt and .pdf files can be added",
    );
    expect(validateKnowledgeUpload({ name: "spec.pdf", size: KNOWLEDGE_UPLOAD_MAX_BYTES + 1 })).toBe(
      "spec.pdf: larger than 10 MB",
    );
    expect(validateKnowledgeUpload({ name: "empty.md", size: 0 })).toBe("empty.md: the file is empty");
  });

  test("every ingest outcome and backend refusal gets its own honest line", () => {
    const done = (status: "stored" | "skipped" | "dropped" | "deferred") =>
      uploadOutcomeCopy("a.md", { phase: "done", result: { id: null, status } });
    expect(done("stored")).toBe("a.md: added");
    expect(done("skipped")).toBe("a.md: already in Knowledge");
    expect(done("dropped")).toContain("not worth saving");
    expect(done("deferred")).toContain("nothing was saved");
    expect(uploadOutcomeCopy("a.md", { phase: "sending" })).toContain("extracting and distilling");
    expect(uploadOutcomeCopy("scan.pdf", { phase: "failed", code: "empty_document" })).toBe(
      "scan.pdf: no text to add (scanned PDFs are not read)",
    );
    expect(uploadOutcomeCopy("x.pdf", { phase: "failed", code: "unreadable_document" })).toContain("could not read");
    expect(uploadOutcomeCopy("x.pdf", { phase: "failed", code: null })).toContain("try again");
  });
});

describe("KnowledgeUploadDrop", () => {
  test("renders an accessible drop target limited to the supported formats with the size hint", () => {
    const html = renderToStaticMarkup(<KnowledgeUploadDrop folder="Global" onIngested={() => {}} />);
    expect(html).toContain('data-testid="knowledge-upload-drop"');
    expect(html).toContain('aria-label="Add documents to Knowledge"');
    expect(html).toContain(`accept="${KNOWLEDGE_UPLOAD_ACCEPT}"`);
    expect(KNOWLEDGE_UPLOAD_ACCEPT).toBe(".md,.txt,.pdf");
    expect(html).toContain("Drop documents here, or click to choose");
    expect(html).toContain("up to 10 MB each");
    expect(html).toContain("scanned pages are not read");
  });

  test("the Knowledge page mounts the drop next to the Add knowledge control", () => {
    const html = renderToStaticMarkup(
      <KnowledgeGallery initialLive initialError={false} initialItems={[]} />,
    );
    expect(html).toContain('data-testid="knowledge-upload-drop"');
    expect(html).toContain(">Add knowledge<");
  });
});
