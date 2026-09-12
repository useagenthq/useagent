import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineDeleteConfirm } from "./inline-delete-confirm";

test("asks the question, states the consequence, and offers Cancel and Delete", () => {
  const html = renderToStaticMarkup(
    <InlineDeleteConfirm
      question="Delete this knowledge?"
      consequence="It disappears from search and from future answers."
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );
  expect(html).toContain('data-testid="inline-delete-confirm"');
  expect(html).toContain("Delete this knowledge?");
  expect(html).toContain("It disappears from search and from future answers.");
  expect(html).toContain(">Cancel<");
  expect(html).toContain(">Delete<");
});
