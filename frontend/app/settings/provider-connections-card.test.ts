import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderConnectionsCard } from "./provider-connections-card";

test("renders the provider connection summary and loading state before client effects", () => {
  const html = renderToStaticMarkup(createElement(ProviderConnectionsCard));

  expect(html).toContain("0 of 3 providers connected");
  expect(html).toContain("Loading provider connections...");
  expect(html).toContain(">Refresh<");
  expect(html).not.toContain("Updates refresh from the org event stream");
});
