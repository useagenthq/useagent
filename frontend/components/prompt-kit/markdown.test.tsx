import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceOpenProvider } from "@/components/chat/workspace-open-context";
import {
  artifactPayloadSupportsWorkspace,
  artifactWorkspaceTarget,
  isSandboxPath,
  Markdown,
} from "./markdown";
import { mermaidThemeName } from "./mermaid-diagram";

describe("Markdown links", () => {
  test("renders downloadable artifacts as compact typed chips", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"[Download report](/api/artifacts/report/content)"}</Markdown>,
    );

    expect(html).toContain('href="/api/artifacts/report/content"');
    expect(html).toContain("Download report");
    expect(html).toContain(">D<"); // round badge shows the label initial
    expect(html).toContain("rounded-full");
  });

  test("keeps web, protocol-relative, route and anchor links as links", () => {
    for (const href of ["//example.com/report.pdf", "/api/reports/report.pdf", "#report.pdf"]) {
      const html = renderToStaticMarkup(<Markdown>{`[Report](${href})`}</Markdown>);
      expect(html).toContain(`href="${href}"`);
    }
    expect(isSandboxPath("file:///root/work/a.pdf")).toBe(true);
    expect(isSandboxPath("/home/user/work/a.pdf")).toBe(true);
    expect(isSandboxPath("output/report.pdf")).toBe(true);
    expect(isSandboxPath("https://x.test/a.pdf")).toBe(false);
    expect(isSandboxPath("/api/artifacts/a.pdf")).toBe(false);
  });

  test("renders unpublished local files as honest inert chips", () => {
    for (const href of [
      "/home/user/work/report.pdf",
      "output/report.pdf",
      "file:///Users/me/report.pdf",
      "sandbox:/root/work/report.pdf",
      "C:/Users/me/report.pdf",
      "/root/work/notes.md",
      "/home/user/work/page.html",
      "/etc/agent/config.toml",
      "/usr/local/share/report.md",
      "out/chart.svg",
    ]) {
      const html = renderToStaticMarkup(
        <WorkspaceOpenProvider value={() => {}}>
          <Markdown>{`[Report](${href})`}</Markdown>
        </WorkspaceOpenProvider>,
      );
      expect(html).toContain("Report");
      expect(html).toContain('title="Local file path - not published"');
      expect(html).not.toContain("href=");
      expect(html).not.toContain("Published under Session files");
    }
  });

  test("preserves formatted labels on inert local links", () => {
    const html = renderToStaticMarkup(
      <WorkspaceOpenProvider value={() => {}}>
        <Markdown>{"[**Quarterly** report](output/report.pdf)"}</Markdown>
      </WorkspaceOpenProvider>,
    );
    expect(html).toContain("<strong>Quarterly</strong> report");
    expect(html).not.toContain("[object Object]");
    expect(html).not.toContain("href=");
  });

  test("renders local images as inert alt text without an image request", () => {
    for (const src of [
      "/Users/me/secret.png",
      "output/secret.png",
      "file:///Users/me/secret.png",
      "sandbox:/root/work/secret.png",
      "C:/Users/me/secret.png",
      "/etc/agent/secret.png",
      "/usr/local/share/secret.png",
    ]) {
      const html = renderToStaticMarkup(
        <WorkspaceOpenProvider value={() => {}}>
          <Markdown>{`![Secret diagram](${src})`}</Markdown>
        </WorkspaceOpenProvider>,
      );
      expect(html).toContain("Secret diagram");
      expect(html).not.toContain("<img");
      expect(html).not.toContain('rel="preload"');
      expect(html).not.toContain(src);
    }
  });

  test("keeps HTTPS and canonical artifact images renderable", () => {
    for (const src of ["https://cdn.example.com/chart.png", "/api/artifacts/a1/content"]) {
      const html = renderToStaticMarkup(<Markdown>{`![Chart](${src})`}</Markdown>);
      expect(html).toContain(`<img src="${src}"`);
      expect(html).toContain('alt="Chart"');
    }
  });

  test("keeps relative wiki links and images renderable outside a session", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"[README](README.md)\n\n![Diagram](docs/diagram.svg)"}</Markdown>,
    );
    expect(html).toContain('href="README.md"');
    expect(html).toContain('<img src="docs/diagram.svg"');
  });

  test("blocks explicit filesystem links and images outside a session", () => {
    const links = [
      "file:///Users/me/secret.txt",
      "/root/api/artifacts/secret.pdf",
      "/home/u/agent/artifacts/file.zip",
      "/etc/agent/secret.txt",
      "/usr/local/share/secret.txt",
    ];
    for (const href of links) {
      const html = renderToStaticMarkup(<Markdown>{`[Secret](${href})`}</Markdown>);
      expect(html).toContain("Secret");
      expect(html).not.toContain("href=");
    }
    const image = renderToStaticMarkup(
      <Markdown>{"![Secret](sandbox:/root/work/secret.png)"}</Markdown>,
    );
    expect(image).toContain("Secret");
    expect(image).not.toContain("<img");
    expect(image).not.toContain('rel="preload"');
  });

  test("keeps only canonical artifact routes on the artifact link path", () => {
    for (const href of [
      "/api/artifacts/artifact-1/content?download=1",
      "/agent/artifacts/artifact-1",
      "https://app.useagent.org/api/artifacts/artifact-1/content",
      "https://app.useagent.org/api/artifacts/artifact-1/content?download=1",
    ]) {
      const html = renderToStaticMarkup(<Markdown>{`[Artifact](${href})`}</Markdown>);
      expect(html).toContain(`href="${href.replace("&", "&amp;")}"`);
      expect(html).toContain("rounded-full");
    }
  });

  test("keeps sanitizer-rejected schemes as inert text", () => {
    for (const href of ["javascript:alert('nope')", "data:text/html,nope"]) {
      const html = renderToStaticMarkup(<Markdown>{`[Open report](${href})`}</Markdown>);
      expect(html).toContain("Open report");
      expect(html).not.toContain("<a");
      expect(html).not.toContain(href);
    }
  });

  test("keeps ordinary links on the plain markdown link path", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"[Documentation](https://useagent.org/docs/)"}</Markdown>,
    );

    expect(html).toContain('href="https://useagent.org/docs/"');
    expect(html).not.toContain("rounded-full");
  });

  test("recognizes old and current workpiece preview URLs", () => {
    expect(
      artifactWorkspaceTarget(
        "/api/artifacts/deck%201/content",
        "Preview the Quarterly deck",
        "https://app.useagent.org",
      ),
    ).toEqual({ id: "deck 1", name: "Quarterly deck" });
    expect(
      artifactWorkspaceTarget(
        "https://app.useagent.org/agent/artifacts/sheet-1",
        "Preview Budget.xlsx",
        "https://app.useagent.org",
      ),
    ).toEqual({ id: "sheet-1", name: "Budget.xlsx" });
    expect(
      artifactWorkspaceTarget(
        "https://app.useagent.org/agent/artifacts/deck-1",
        "Open presentation preview",
        "https://app.useagent.org",
      ),
    ).toEqual({ id: "deck-1", name: "presentation" });
    expect(
      artifactWorkspaceTarget(
        "/api/artifacts/deck-1/content?download=1",
        "Preview deck",
        "https://app.useagent.org",
      ),
    ).toBeNull();
    expect(
      artifactWorkspaceTarget(
        "https://evil.example/api/artifacts/deck-1/content",
        "Preview deck",
        "https://app.useagent.org",
      ),
    ).toBeNull();
  });

  test("does not speculate about workspace support before metadata resolves", () => {
    const html = renderToStaticMarkup(
      <WorkspaceOpenProvider value={() => {}}>
        <Markdown>{"[Preview the deck](/api/artifacts/deck-1/content)"}</Markdown>
      </WorkspaceOpenProvider>,
    );

    expect(html).toContain('href="/api/artifacts/deck-1/content"');
    expect(html).toContain('target="_blank"');
  });

  test("uses authoritative artifact metadata for workspace eligibility", () => {
    expect(
      artifactPayloadSupportsWorkspace({ artifact: { workpiece: { kind: "presentation" } } }),
    ).toBe(true);
    expect(
      artifactPayloadSupportsWorkspace({
        artifact: { workpiece: null, preview_pdf_url: "/preview" },
      }),
    ).toBe(true);
    expect(
      artifactPayloadSupportsWorkspace({
        artifact: { content_type: "video/mp4", workpiece: null, preview_pdf_url: null },
      }),
    ).toBe(false);
  });

  test("keeps artifact Download chips as download links inside a session", () => {
    const html = renderToStaticMarkup(
      <WorkspaceOpenProvider value={() => {}}>
        <Markdown>{"[Download the deck](/api/artifacts/deck-1/content?download=1)"}</Markdown>
      </WorkspaceOpenProvider>,
    );

    expect(html).toContain('href="/api/artifacts/deck-1/content?download=1"');
    expect(html).toContain('target="_blank"');
  });
});

describe("Markdown long words", () => {
  test("wraps unbroken words in the column while tables keep natural widths", () => {
    const html = renderToStaticMarkup(
      <Markdown>{`https://example.com/${"a".repeat(200)}`}</Markdown>,
    );

    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).toContain("[&amp;_table]:[overflow-wrap:normal]");
  });
});

describe("Markdown mermaid blocks", () => {
  const diagram = "```mermaid\ngraph TD\n  A[Start] --> B[End]\n```";

  test("falls back to the plain code block, source and copy button intact", () => {
    // Server render (and any client state before the lazily loaded library
    // arrives, or after a parse failure) is the fallback: the source in a
    // code block card, never an error or a blank.
    const html = renderToStaticMarkup(<Markdown>{diagram}</Markdown>);

    expect(html).toContain("graph TD");
    expect(html).toContain("Start");
    expect(html).toContain(">Mermaid<"); // header label on the fallback card
    expect(html).toContain("Copy"); // the copy button still copies the source
    expect(html).not.toContain("mermaid-diagram-");
  });

  test("a broken mermaid block shows its source the same way", () => {
    const broken = "```mermaid\ngraph TD\n  A -->>>\n```";
    const html = renderToStaticMarkup(<Markdown>{broken}</Markdown>);

    expect(html).toContain("graph TD");
    expect(html).toContain(">Mermaid<");
    expect(html).toContain("Copy");
  });

  test("picks the mermaid palette that follows the app theme", () => {
    expect(mermaidThemeName(true)).toBe("dark");
    expect(mermaidThemeName(false)).toBe("default");
  });

  test("other fenced blocks keep the code block path", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"```ts\nconst answer = 42;\n```"}</Markdown>,
    );

    expect(html).toContain("const answer = 42;");
    expect(html).toContain(">TypeScript<");
  });
});
