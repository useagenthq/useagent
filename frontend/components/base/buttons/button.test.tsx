import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./button";

function TestIcon() {
  return <svg />;
}

test("medium icon-only buttons remain square after the density pass", () => {
  const html = renderToStaticMarkup(<Button iconOnly leadingIcon={TestIcon} aria-label="Add" />);

  expect(html).toContain("size-8");
  expect(html).toContain("p-0");
});
