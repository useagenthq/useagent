import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineNode } from "./timeline";
import { Timeline } from "./timeline-view";

function renderArtifact(artifact: Extract<TimelineNode, { kind: "artifact" }>["artifact"]): string {
  return renderToStaticMarkup(
    <Timeline
      nodes={[{ kind: "artifact", key: `artifact:${artifact.id}`, artifact }]}
      live={false}
    />,
  );
}

describe("timeline artifact rendering", () => {
  test("renders image content inline with expand, preview, download, and delivery badges", () => {
    const html = renderArtifact({
      id: "image-1",
      name: "launch-chart.png",
      bytes: 2048,
      sha256: "a".repeat(64),
      contentType: "image/png",
      destinations: ["email", "slack"],
    });

    expect(html).toContain('src="/api/artifacts/image-1/content"');
    expect(html).toContain('alt="Preview of launch-chart.png"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('aria-label="Expand launch-chart.png"');
    expect(html).toContain('aria-label="Preview launch-chart.png"');
    expect(html).toContain('href="/api/artifacts/image-1/content"');
    expect(html).toContain('aria-label="Download launch-chart.png"');
    expect(html).toContain('href="/api/artifacts/image-1/content?download=1"');
    expect(html).toContain("Delivered to Email");
    expect(html).toContain("Delivered to Slack");
  });

  test("keeps non-image artifacts on the existing file-card action path", () => {
    const html = renderArtifact({
      id: "pdf-1",
      name: "report.pdf",
      bytes: 4096,
      sha256: "b".repeat(64),
      contentType: "application/pdf",
    });

    expect(html).toContain("report.pdf");
    expect(html).toContain("Artifact · 4.0 KB");
    expect(html).toContain('aria-label="Preview report.pdf"');
    expect(html).toContain('aria-label="Download report.pdf"');
    expect(html).not.toContain('aria-label="Expand report.pdf"');
    expect(html).not.toContain("<img");
  });

  test("keeps active SVG content attachment-only", () => {
    const html = renderArtifact({
      id: "svg-1",
      name: "diagram.svg",
      bytes: 1024,
      sha256: "d".repeat(64),
      contentType: "image/svg+xml",
    });

    expect(html).toContain("diagram.svg");
    expect(html).toContain('aria-label="Download diagram.svg"');
    expect(html).not.toContain('aria-label="Expand diagram.svg"');
    expect(html).not.toContain("<img");
  });

  test("legacy single-destination nodes retain content actions", () => {
    const html = renderArtifact({
      id: "legacy-1",
      name: "legacy.png",
      bytes: 1024,
      sha256: "c".repeat(64),
      contentType: "image/png",
      destination: "slack",
    });

    expect(html).toContain("Delivered to Slack");
    expect(html).toContain('src="/api/artifacts/legacy-1/content"');
    expect(html).toContain('aria-label="Preview legacy.png"');
    expect(html).toContain('aria-label="Download legacy.png"');
  });
});
