import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { recordToItem, type KnowledgeItem } from "./knowledge-data";
import { KnowledgeGallery } from "./knowledge-gallery";
import { KnowledgeRow } from "./knowledge-rows";

test("recordToItem carries the flattened backend fields into the row model", () => {
  const item = recordToItem({
    id: "r1",
    kind: "qa",
    title: "How do we deploy?",
    body: "Use the deploy script.",
    refs: ["runbook.md"],
    domain: "Global",
    connector_instance_id: "manual:web",
    source_type: "document",
    source_url: "https://example.com/doc",
    summary: "Deploys go through the script.",
    question: "How do we deploy?",
    confidence: 0.8,
    entities: ["deploy"],
    pinned: true,
    created_at: new Date().toISOString(),
  });
  expect(item.folder).toBe("Global");
  expect(item.sourceType).toBe("document");
  expect(item.sourceUrl).toBe("https://example.com/doc");
  expect(item.summary).toBe("Deploys go through the script.");
  expect(item.question).toBe("How do we deploy?");
  expect(item.confidence).toBe(0.8);
  expect(item.refs).toEqual(["runbook.md"]);
  expect(item.entities).toEqual(["deploy"]);
  expect(item.connectorId).toBe("manual:web");
  expect(item.pinned).toBe(true);
});

test("rows clamp the body behind an expand affordance and keep pin/delete wired", () => {
  const markup = renderToStaticMarkup(
    <ul>
      <KnowledgeRow
        item={{
          id: "k1",
          title: "Prefer semantic tokens",
          body: "Use the design system tokens everywhere.",
          folder: "useAgent",
          kind: "policy",
          updated: "2d ago",
          pinned: false,
          sourceType: "document",
        }}
        onTogglePin={() => {}}
        onDelete={() => {}}
      />
    </ul>,
  );
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain("line-clamp-2");
  expect(markup).toContain('aria-label="Pin Prefer semantic tokens"');
  expect(markup).toContain('aria-label="Delete Prefer semantic tokens"');
  expect(markup).toContain(">policy<");
});

test("the list caps the initial render behind a Show-more disclosure", () => {
  const items: KnowledgeItem[] = Array.from({ length: 34 }, (_, i) => ({
    id: `k${i}`,
    title: `Fact ${i}`,
    body: `Body ${i}`,
    folder: "Global",
    updated: "1d ago",
    pinned: false,
  }));
  const markup = renderToStaticMarkup(
    <KnowledgeGallery initialLive initialError={false} initialItems={items} />,
  );
  expect(markup).toContain("Show 4 more");
  expect(markup).toContain("Fact 29");
  expect(markup).not.toContain("Fact 30");
});
