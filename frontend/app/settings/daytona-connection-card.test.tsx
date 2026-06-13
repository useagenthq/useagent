import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DaytonaConnectionCard } from "./daytona-connection-card";
import { ProviderConnectionsProvider } from "./use-provider-connections";

test("renders an honest loading shell without credential material", () => {
  const html = renderToStaticMarkup(
    createElement(ProviderConnectionsProvider, null, createElement(DaytonaConnectionCard)),
  );
  expect(html).toContain("Managed Cube");
  expect(html).toContain("Daytona");
  expect(html).toContain("Loading Daytona connection...");
  expect(html).not.toContain("DAYTONA_API_KEY");
  expect(html).not.toContain("credentialCiphertext");
});
