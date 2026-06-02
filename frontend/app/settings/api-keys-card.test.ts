import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiKeysCard } from "./api-keys-card";

test("renders the create form and loading state before client effects", () => {
  const html = renderToStaticMarkup(createElement(ApiKeysCard));

  // Create affordance + the scope note are present on first paint.
  expect(html).toContain("Create key");
  expect(html).toContain("It cannot manage secrets, settings, or other keys.");
  // Self-fetch has not resolved yet, so the loading branch shows.
  expect(html).toContain("Loading API keys...");
  // No secret is revealed until a key is actually created.
  expect(html).not.toContain("Store it now, it is not shown again.");
});

test("user-visible copy uses no em dashes (repo law)", () => {
  const html = renderToStaticMarkup(createElement(ApiKeysCard));
  expect(html).not.toContain("—");
});
