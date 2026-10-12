import { type NextRequest, NextResponse } from "next/server";

const SESSION_COOKIES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
] as const;

function routeResponse(request: NextRequest): NextResponse | null {
  const { pathname } = request.nextUrl;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    const canonical = new URL(request.url);
    canonical.pathname = pathname.replace(/\/+$/, "");
    return NextResponse.redirect(canonical, 308);
  }
  if (
    pathname === "/healthz" ||
    pathname === "/icon.svg" ||
    pathname.endsWith("/opengraph-image") ||
    pathname.endsWith("/twitter-image")
  ) {
    return NextResponse.next();
  }
  return null;
}

function isPublicPage(pathname: string): boolean {
  return (
    pathname === "/desktop-auth" ||
    pathname === "/download" ||
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/signup" ||
    pathname.startsWith("/signup/")
  );
}

export function proxy(request: NextRequest): NextResponse {
  const response = routeResponse(request);
  if (response) return response;
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));
  const preview = process.env.NODE_ENV !== "production" && process.env.USEAGENT_PREVIEW_OPEN === "1";
  if (!preview && !hasSession && !isPublicPage(request.nextUrl.pathname)) {
    // An invitation link must survive the sign-in it triggers.
    if (request.nextUrl.pathname.startsWith("/accept-invitation/")) {
      const login = new URL("/login", request.url);
      login.searchParams.set("redirect_url", request.nextUrl.pathname);
      return NextResponse.redirect(login);
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const headers = new Headers(request.headers);
  headers.delete("x-nonce");
  headers.delete("content-security-policy");
  // These are data/chunk fetches, not new documents. Keep router prefetch and
  // RSC caching intact, but never bypass the authentication checks above.
  if (headers.get("rsc") === "1" || headers.get("next-router-prefetch") === "1" || headers.get("purpose") === "prefetch") {
    return NextResponse.next({ request: { headers } });
  }
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const development = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const policy = `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${development}; script-src-attr 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);
  const page = NextResponse.next({ request: { headers } });
  page.headers.set("content-security-policy", policy);
  page.headers.set("cache-control", "private, no-store");
  return page;
}

export const config = {
  matcher: [
    "/((?!api|v2|healthz|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
