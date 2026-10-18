import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { knowledgeFolderLabel, knowledgeItemForDisplay, LEGACY_PRODUCT_FOLDER, seedFolders } from "./knowledge-data";
import { KnowledgeGallery } from "./knowledge-gallery";

test("keeps the persisted knowledge folder key while displaying UseAgent", () => {
  // Stored items carry this key; the literal is pinned so a rename fails here.
  expect(LEGACY_PRODUCT_FOLDER).toBe("skynet-app");
  expect(seedFolders).toContain("useagent-app");
  expect(knowledgeFolderLabel("useagent-app")).toBe("UseAgent");
  expect(knowledgeFolderLabel(LEGACY_PRODUCT_FOLDER)).toBe("UseAgent");
  expect(knowledgeFolderLabel("Engineering")).toBe("Engineering");
  const storedItem = {
    id: "knowledge-1",
    title: "Prefer semantic tokens",
    body: "Use the design system tokens.",
    folder: LEGACY_PRODUCT_FOLDER,
    updated: "now",
    pinned: false,
  };
  expect(knowledgeItemForDisplay(storedItem).folder).toBe("UseAgent");
  expect(storedItem.folder).toBe(LEGACY_PRODUCT_FOLDER);

  const gallery = renderToStaticMarkup(
    <KnowledgeGallery initialLive initialError={false} initialItems={[storedItem]} />,
  );
  expect(gallery).toContain(">UseAgent<");
  expect(gallery).not.toContain(`>${LEGACY_PRODUCT_FOLDER}<`);
});
