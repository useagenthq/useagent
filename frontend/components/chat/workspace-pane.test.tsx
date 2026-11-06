import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkpieceTabStrip } from "./workspace-pane";

test("the tab and the close button carry the focus ring", () => {
  const html = renderToStaticMarkup(
    <WorkpieceTabStrip
      tabs={[{ id: "notes", name: "notes.md" }]}
      activeId="notes"
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
  const rings = html.match(/focus-visible:ring-border-focus-ring/g) ?? [];
  expect(rings.length).toBe(2);
});
