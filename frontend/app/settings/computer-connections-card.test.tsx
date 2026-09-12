import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComputerConnectionsCard } from "./computer-connections-card";
import { computerFooterCopy } from "./provider-connections-data";
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

test("the footer line never claims a connection the chip does not show", () => {
  // Personal computers on, nothing stored: what a key WOULD change.
  expect(computerFooterCopy("Daytona", true, false)).toBe(
    "Once a key is stored, Daytona runs your threads on your own account instead of the server's computer.",
  );
  // Personal computers on, key stored: the only state that says connected.
  expect(computerFooterCopy("Box", true, true)).toBe(
    "Connected. Box runs your threads on your own account.",
  );
  // Flag off: the server's computer keeps running work, connected or not.
  const flagOff = "Stored for now. Runs stay on the server's computer until USER_COMPUTERS=on is set.";
  expect(computerFooterCopy("Daytona", false, false)).toBe(flagOff);
  expect(computerFooterCopy("Daytona", false, true)).toBe(flagOff);
  // Flag unknown while /api/config loads.
  expect(computerFooterCopy("Daytona", null, false)).toBe(
    "Checking whether personal computers run your work on this server...",
  );
});
