import { type NextRequest, NextResponse } from "next/server";

const SESSION_COOKIES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
] as const;

/**
 * Route anonymous browser traffic to the real application login. Cookie
 * presence is only a navigation hint; every backend API still validates the
 * Better Auth session and fails closed independently.
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname === "/healthz") return NextResponse.next();

  // Local preview escape hatch (used by `bun run local`): skip the login redirect
  // so the app renders against a remote API for UI work. HARD-GATED to development
  // - NODE_ENV is 'production' in every real build, so this can never open auth in
  // production even if the flag leaks into an env. Backend APIs still validate the
  // Better Auth session independently and fail closed.
  if (process.env.NODE_ENV !== "production" && process.env.USEAGENT_PREVIEW_OPEN === "1") {
    return NextResponse.next();
  }
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));
  if (hasSession) return NextResponse.next();

  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: [
    "/((?!api|healthz|login|signup|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
