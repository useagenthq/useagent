import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InboundAttachments } from "./inbound-attachments";
import type { RunUpload } from "./types";

function upload(over: Partial<RunUpload> = {}): RunUpload {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "diagram.png",
    content_type: "image/png",
    size_bytes: 2048,
    created_at: "2026-08-20T09:00:00Z",
    ...over,
  };
}

test("renders an image attachment as a bounded, lazy inline img from the content route", () => {
  const html = renderToStaticMarkup(<InboundAttachments uploads={[upload()]} />);
  expect(html).toContain('src="/api/uploads/11111111-1111-1111-1111-111111111111/content"');
  expect(html).toContain('loading="lazy"');
  // Bounded height so a large image never blows out the turn.
  expect(html).toContain("max-h-64");
  expect(html).toContain('alt="diagram.png"');
});

test("renders a non-image attachment as a file card with name, size, and download", () => {
  const html = renderToStaticMarkup(
    <InboundAttachments
      uploads={[upload({ name: "report.pdf", content_type: "application/pdf", size_bytes: 5120 })]}
    />,
  );
  expect(html).toContain("report.pdf");
  expect(html).toContain("5.0 KB");
  // A download link to the content route, not an inline <img>.
  expect(html).toContain('download="report.pdf"');
  expect(html).not.toContain("<img");
});

test("renders nothing when there are no attachments", () => {
  expect(renderToStaticMarkup(<InboundAttachments uploads={[]} />)).toBe("");
  expect(renderToStaticMarkup(<InboundAttachments uploads={undefined} />)).toBe("");
});

test("mixes image and file attachments in one turn", () => {
  const html = renderToStaticMarkup(
    <InboundAttachments
      uploads={[
        upload({ id: "aaaaaaaa-1111-1111-1111-111111111111", name: "shot.png" }),
        upload({
          id: "bbbbbbbb-2222-2222-2222-222222222222",
          name: "notes.txt",
          content_type: "text/plain",
        }),
      ]}
    />,
  );
  expect(html).toContain('alt="shot.png"');
  expect(html).toContain("notes.txt");
  expect(html).toContain('download="notes.txt"');
});
