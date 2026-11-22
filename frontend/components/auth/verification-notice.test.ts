import { expect, test } from "bun:test";
import { verificationNotice } from "./verification-notice";

test("a confirmation landing is explained in plain words, problems before success", () => {
  expect(verificationNotice({})).toBeNull();
  expect(verificationNotice({ verified: "1" })).toEqual({
    tone: "ok",
    text: "Your email address is confirmed. Sign in to continue.",
  });
  expect(verificationNotice({ verified: "1", error: "link_expired" })?.text).toContain("has expired");
  expect(verificationNotice({ error: "link_invalid" })?.text).toContain("is not valid");
  expect(verificationNotice({ error: "signup_replaced" })?.text).toContain("a newer one replaced");
  expect(verificationNotice({ declined: "1" })?.text).toContain("was cancelled");
  expect(verificationNotice({ declined: "nothing" })?.text).toContain("Nothing was cancelled");
  expect(verificationNotice({ error: ["a", "b"] })).toBeNull();
});

test("a failed provider sign-in is explained by its code, never by echoing the query", () => {
  expect(verificationNotice({ via: "provider", error: "Account_creation_is_disabled" })?.text).toBe(
    "This server did not create an account for that address. Ask a workspace admin to invite it. An invitation needs an address your sign-in provider has confirmed.",
  );
  expect(verificationNotice({ via: "provider", error: "Sign-up_is_limited_to_@acme.com_addresses" })?.text).toContain("did not create an account");
  expect(verificationNotice({ via: "provider", error: "That_invite_code_is_not_valid" })?.text).toContain("did not create an account");
  expect(verificationNotice({ via: "provider", error: "account_not_linked" })?.text).toContain("Sign in with your password instead.");
  const other = verificationNotice({ via: "provider", error: "Call_555_0100_to_restore_access" });
  expect(other).toEqual({ tone: "problem", text: "That sign-in did not work. Please try again." });
  // Without the marker, an error is still about a confirmation link.
  expect(verificationNotice({ error: "Account_creation_is_disabled" })?.text).toContain("confirmation link is not valid");
  expect(verificationNotice({ via: "provider" })).toBeNull();
});
