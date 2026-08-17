import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BeuiAgentInventory } from "./beui-agent-inventory";

test("renders the beUI agent inventory lane with canonical reusable primitives", () => {
  const html = renderToStaticMarkup(<BeuiAgentInventory />);
  const renderedComponents = html.match(/data-beui-agent-component=/g) ?? [];

  expect(renderedComponents).toHaveLength(8);
  expect(html).toContain("beUI agent inventory");
  expect(html).toContain("Prompt Input");
  expect(html).toContain("Approvals and Questions");
  expect(html).toContain("Streaming Response");
  expect(html).toContain("Chat App");
  expect(html).toContain("rejected");
  expect(html).toContain("Which agent primitive should be promoted first?");
});
