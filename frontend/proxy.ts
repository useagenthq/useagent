import { type NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIES = [
  '__Secure-better-auth.session_token',
  'better-auth.session_token',
] as const;

/**
 * Route anonymous browser traffic to the real application login. Cookie
 * presence is only a navigation hint; every backend API still validates the
 * Better Auth session and fails closed independently.
 */
export function proxy(request: NextRequest): NextResponse {
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));
  if (hasSession) return NextResponse.next();

  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  matcher: [
    '/((?!api|login|signup|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
