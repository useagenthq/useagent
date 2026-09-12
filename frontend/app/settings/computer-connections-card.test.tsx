import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComputerConnectionsCard } from "./computer-connections-card";
import { ProviderConnectionsProvider } from "./use-provider-connections";

test("renders an honest loading shell for every computer provider without credential material", () => {
  const html = renderToStaticMarkup(
    createElement(ProviderConnectionsProvider, null, createElement(ComputerConnectionsCard)),
  );
  expect(html).toContain("Managed Cube");
  expect(html).toContain("Loading Daytona connection...");
  expect(html).toContain("Loading Box connection...");
  expect(html).not.toContain("DAYTONA_API_KEY");
  expect(html).not.toContain("BOX_API_KEY");
  expect(html).not.toContain("credentialCiphertext");
});
