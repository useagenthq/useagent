import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { knowledgeFolderLabel, knowledgeItemForDisplay, seedFolders } from "./knowledge-data";
import { KnowledgeGallery } from "./knowledge-gallery";

test("keeps the persisted knowledge folder key while displaying useAgent", () => {
  expect(seedFolders).toContain("useagent-app");
  expect(knowledgeFolderLabel("useagent-app")).toBe("useAgent");
  expect(knowledgeFolderLabel("skynet-app")).toBe("useAgent");
  expect(knowledgeFolderLabel("Engineering")).toBe("Engineering");
  const storedItem = {
    id: "knowledge-1",
    title: "Prefer semantic tokens",
    body: "Use the design system tokens.",
    folder: "skynet-app",
    updated: "now",
    pinned: false,
  };
  expect(knowledgeItemForDisplay(storedItem).folder).toBe("useAgent");
  expect(storedItem.folder).toBe("skynet-app");

  const gallery = renderToStaticMarkup(
    <KnowledgeGallery initialLive initialError={false} initialItems={[storedItem]} />,
  );
  expect(gallery).toContain(">useAgent<");
  expect(gallery).not.toContain(">skynet-app<");
});
