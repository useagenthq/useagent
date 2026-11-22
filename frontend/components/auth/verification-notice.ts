/**
 * What the login card says about a confirmation link that landed here. The
 * backend sends every confirming click to `/login?verified=1`, or to
 * `/login?error=<code>` when the link was not good. A Google or OpenID Connect
 * sign-in that failed lands on `/login?via=provider&error=<code>`
 * (`providerErrorURL` in lib/auth.ts).
 */
export interface VerificationNotice {
  readonly tone: "ok" | "problem";
  readonly text: string;
}

/** The codes better-auth sends back when the sign-up policy refused to create
 *  an account (`signupRefusal` in the backend): its message, spaces made `_`. */
const REFUSED_ACCOUNT = /^(Account_creation_is_disabled|Sign-up_is_limited_to_|That_invite_code_is_not_valid)/;

/** A failed provider sign-in, by code only: the query string is never echoed. */
function providerNotice(error: string): VerificationNotice {
  if (error === "account_not_linked") {
    return {
      tone: "problem",
      text: "An account with that address already exists, and your sign-in provider has not confirmed the address. Sign in with your password instead.",
    };
  }
  if (REFUSED_ACCOUNT.test(error)) {
    return {
      tone: "problem",
      text: "This server did not create an account for that address. Ask a workspace admin to invite it. An invitation needs an address your sign-in provider has confirmed.",
    };
  }
  return { tone: "problem", text: "That sign-in did not work. Please try again." };
}

export function verificationNotice(params: {
  verified?: string | string[];
  declined?: string | string[];
  error?: string | string[];
  via?: string | string[];
}): VerificationNotice | null {
  const error = typeof params.error === "string" ? params.error : null;
  if (error && params.via === "provider") return providerNotice(error);
  if (error === "signup_replaced") {
    return {
      tone: "problem",
      text: "That confirmation link is from an earlier sign-up that a newer one replaced. Sign up again to get a fresh link.",
    };
  }
  if (error === "link_expired") {
    return {
      tone: "problem",
      text: "That confirmation link has expired. Sign in with your password and we will send a new one.",
    };
  }
  if (error) {
    return {
      tone: "problem",
      text: "That confirmation link is not valid. Sign in with your password and we will send a new one.",
    };
  }
  if (params.verified === "1") return { tone: "ok", text: "Your email address is confirmed. Sign in to continue." };
  if (params.declined === "1") return { tone: "ok", text: "That sign-up was cancelled. Nothing was created for your address." };
  if (params.declined === "nothing") {
    return {
      tone: "problem",
      text: "Nothing was cancelled: that sign-up was already confirmed, or a newer sign-up for the address replaced it.",
    };
  }
  return null;
}
