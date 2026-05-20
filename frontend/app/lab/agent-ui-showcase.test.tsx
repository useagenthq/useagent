import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentUiShowcase } from "./agent-ui-showcase";

test("makes every agent primitive navigable and visible from the lab", () => {
  const html = renderToStaticMarkup(<AgentUiShowcase />);
  const renderedComponents = html.match(/data-agent-ui-component=/g) ?? [];

  expect(renderedComponents).toHaveLength(7);
  expect(html).toContain('aria-label="Agent component examples"');
  expect(html).toContain('href="#approval-request"');
  expect(html).toContain('href="#subagent-status"');
  expect(html).toContain("Approval required to run a command");
  expect(html).toContain("Component verification");
});
