import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityShareRow } from "./entity-share-row";

describe("EntityShareRow", () => {
  test("pill width is the value's share of the max", () => {
    const html = renderToStaticMarkup(<EntityShareRow label="acme/web" value={5} max={10} />);
    expect(html).toContain("width:50%");
    expect(html).toContain("acme/web");
    expect(html).toContain("overflow-hidden");
    expect(html).not.toContain("min-w-fit");
  });

  test("a small non-zero share still floors to a visible bar", () => {
    const html = renderToStaticMarkup(<EntityShareRow label="tiny" value={1} max={100} />);
    // 1/100 = 1% floors up to the 6% minimum so the pill never collapses.
    expect(html).toContain("width:6%");
  });

  test("max of zero yields no bar rather than a divide-by-zero", () => {
    const html = renderToStaticMarkup(<EntityShareRow label="none" value={0} max={0} />);
    expect(html).toContain("width:0%");
  });

  test("formats the count and renders the leading, caption, and trailing slots", () => {
    const html = renderToStaticMarkup(
      <EntityShareRow
        label="acme/web"
        value={1234}
        max={2000}
        formatValue={(n) => `${n} runs`}
        leading={<span>lead</span>}
        caption={<span>2 working</span>}
        trailing={<span>trail</span>}
      />,
    );
    expect(html).toContain("1234 runs");
    expect(html).toContain("lead");
    expect(html).toContain("2 working");
    expect(html).toContain("trail");
  });
});
