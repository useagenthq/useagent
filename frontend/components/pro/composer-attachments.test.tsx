import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunUpload } from "@/components/chat/run-uploads";
import {
  ComposerAttachmentRow,
  ComposerUploadNotice,
  composerAttachment,
} from "./composer-attachments";
import { ComposerAddButton } from "./composer-panel/composer-panel";

function upload(over: Partial<RunUpload> = {}): RunUpload {
  return {
    localId: "u1",
    id: "up-1",
    name: "shot.png",
    sizeBytes: 10,
    status: "ready",
    kind: "image",
    previewUrl: "blob:local/shot",
    progress: 100,
    ...over,
  };
}

const row = (uploads: RunUpload[]) =>
  renderToStaticMarkup(<ComposerAttachmentRow uploads={uploads} onRemove={() => {}} />);

describe("upload to tile", () => {
  test("a landed upload is a plain tile, one in flight carries its progress, a failed one says so", () => {
    expect(composerAttachment(upload())).toEqual({
      id: "u1",
      name: "shot.png",
      kind: "image",
      src: "blob:local/shot",
    });
    expect(composerAttachment(upload({ status: "uploading", progress: 42, previewUrl: null }))).toEqual({
      id: "u1",
      name: "shot.png",
      kind: "image",
      progress: 42,
    });
    expect(composerAttachment(upload({ status: "error", kind: "file", previewUrl: null }))).toEqual({
      id: "u1",
      name: "shot.png",
      kind: "file",
      failed: true,
    });
  });
});

describe("composer attachment tiles", () => {
  test("an image tile shows its thumbnail and a remove mark", () => {
    const html = row([upload()]);
    expect(html).toContain('data-attachment-kind="image"');
    expect(html).toContain('data-status="ready"');
    expect(html).toContain('src="blob:local/shot"');
    expect(html).toContain('alt="shot.png"');
    expect(html).toContain('aria-label="Remove shot.png"');
  });

  test("typed files show their icon over the name; unknown ones the paperclip", () => {
    const cases: [RunUpload["kind"], string][] = [
      ["spreadsheet", "plugin-spreadsheets.svg"],
      ["presentation", "plugin-presentations.svg"],
      ["document", "plugin-documents.svg"],
      ["code", "plugin-codeblocks.svg"],
      ["video", "plugin-videos.svg"],
    ];
    for (const [kind, icon] of cases) {
      const html = row([upload({ kind, name: `a.${kind}`, previewUrl: null })]);
      expect(html).toContain(icon);
      expect(html).toContain(`>a.${kind}<`);
      expect(html).toContain(`aria-label="Remove a.${kind}"`);
    }
    const plain = row([upload({ kind: "file", name: "trace.zip", previewUrl: null })]);
    expect(plain).not.toContain("plugin-");
    expect(plain).toContain('data-attachment-kind="file"');
    expect(plain).toContain(">trace.zip<");
  });

  test("in flight the ring draws the progress and the remove mark waits; a failure is named and removable", () => {
    const inFlight = row([upload({ status: "uploading", progress: 42 })]);
    expect(inFlight).toContain('data-status="uploading"');
    expect(inFlight).toContain('stroke-dasharray="42 200"');
    expect(inFlight).toContain(">42%<");
    expect(inFlight).toContain("Uploading, 42%");
    // The dismiss stays in the tree for its blur-in at 100, but it is disabled meanwhile.
    const dismiss = inFlight.match(/<button[^>]*aria-label="Remove shot.png"[^>]*>/)?.[0] ?? "";
    expect(dismiss).toContain("disabled");
    const failed = row([upload({ status: "error" })]);
    expect(failed).toContain('data-status="error"');
    expect(failed).toContain('aria-label="Upload failed"');
    const failedDismiss = failed.match(/<button[^>]*aria-label="Remove shot.png"[^>]*>/)?.[0] ?? "";
    expect(failedDismiss).not.toContain("disabled");
    expect(row([upload()])).not.toContain("Upload failed");
  });
});

describe("composer attachment row", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      upload({ localId: `u${i}`, name: `file-${i}.pdf`, kind: "document", previewUrl: null }),
    );

  test("renders nothing without uploads", () => {
    expect(row([])).toBe("");
  });

  test("shows eight tiles and folds the rest behind a count", () => {
    const ten = row(many(10));
    expect(ten.match(/data-attachment-kind=/g)?.length).toBe(8);
    expect(ten).toContain('aria-label="Show 2 more attachments"');
    expect(ten).toContain(">+2<");
    const eight = row(many(8));
    expect(eight.match(/data-attachment-kind=/g)?.length).toBe(8);
    expect(eight).not.toContain("more attachments");
  });

  test("every landed tile carries its own remove control in one labelled list", () => {
    const html = row(many(3));
    expect(html).toContain('aria-label="Attached files"');
    expect(html).toContain('role="list"');
    for (const i of [0, 1, 2]) expect(html).toContain(`aria-label="Remove file-${i}.pdf"`);
  });

  test("the strip follows the reduced-motion preference", () => {
    // Static markup cannot observe MotionConfig, so the contract is read from the
    // strip's source: its tile motion sits under reducedMotion="user".
    const source = readFileSync(new URL("./composer-panel/composer-panel.tsx", import.meta.url), "utf8");
    const strip = source.slice(source.indexOf("export function ComposerAttachmentStrip"));
    const config = strip.indexOf('<MotionConfig reducedMotion="user">');
    expect(config).toBeGreaterThan(-1);
    expect(config).toBeLessThan(strip.indexOf("<AnimatePresence"));
  });
});

describe("composer add button", () => {
  test("is the menu trigger and reports its open state", () => {
    const closed = renderToStaticMarkup(
      <ComposerAddButton aria-label="Add context" open={false} onToggle={() => {}} />,
    );
    expect(closed).toContain('aria-label="Add context"');
    expect(closed).toContain('aria-haspopup="menu"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain("rounded-full");
    expect(closed).toContain("bg-composer-panel-add-background");
    expect(closed).not.toContain("rotate-45");
    const open = renderToStaticMarkup(
      <ComposerAddButton aria-label="Add context" open onToggle={() => {}} />,
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("rotate-45");
  });
});

describe("why a tile failed", () => {
  test("a failed upload carries its reason to the tile's label and tooltip", () => {
    const failed = upload({
      status: "error",
      name: "report.pdf",
      kind: "document",
      previewUrl: null,
      error: "is over the 25 MB limit",
    });
    expect(composerAttachment(failed)).toMatchObject({
      failed: true,
      failedReason: "is over the 25 MB limit",
    });
    const html = row([failed]);
    expect(html).toContain('aria-label="Upload failed: report.pdf is over the 25 MB limit"');
    expect(html).toContain('title="report.pdf is over the 25 MB limit"');
  });

  test("the notice line is a live region, quiet and hidden when there is nothing to say", () => {
    const empty = renderToStaticMarkup(<ComposerUploadNotice notice={null} />);
    expect(empty).toContain('role="status"');
    expect(empty).toContain("sr-only");
    const error = renderToStaticMarkup(
      <ComposerUploadNotice
        notice={{ tone: "error", text: "Remove report.pdf to send. It is empty." }}
        className="px-3"
      />,
    );
    expect(error).toContain("text-text-error-primary");
    expect(error).toContain("Remove report.pdf to send. It is empty.");
    expect(error).not.toContain("sr-only");
  });
});
