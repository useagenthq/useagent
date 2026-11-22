import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { OidcSignInButton } from "./oidc-sign-in-button";

test("names the deployment's identity provider on the button", () => {
  const html = renderToStaticMarkup(<OidcSignInButton label="Acme SSO" />);
  expect(html).toContain("Sign in with Acme SSO");
  expect(html).toContain('aria-label="Sign in with Acme SSO"');
});
