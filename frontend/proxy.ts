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
    pathname.startsWith("/og/") ||
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

const BOT_USER_AGENTS =
  /bot|crawl|spider|slurp|facebookexternalhit|facebot|twitterbot|whatsapp|telegrambot|slackbot|discordbot|linkedinbot|opengraph|vkshare|w3c_validator|skypeuripreview|qwantify|pinterest|embedly|quora link preview|yahoo! slurp|apple-pubsub|chrome\/14\d|headless|phantom|puppeteer|lighthouse|ptst/i;

interface RouteMeta {
  title: string;
  description: string;
  image: string;
}

const ROUTE_METADATA: Array<{ pattern: RegExp; meta: RouteMeta }> = [
  {
    pattern: /^\/dashboard(\/.*)?$/,
    meta: {
      title: "Dashboard - UseAgent",
      description: "Monitor agent fleet activity, workspace metrics, and execution history.",
      image: "/og/04-dashboard.png",
    },
  },
  {
    pattern: /^\/bots(\/.*)?$/,
    meta: {
      title: "Bots - UseAgent",
      description: "Automate tasks with always-on AI bots that run in your workspace.",
      image: "/og/05-agents.png",
    },
  },
  {
    pattern: /^\/(agent\/)?automations(\/.*)?$/,
    meta: {
      title: "Automations - UseAgent",
      description: "Recurring and triggered runs UseAgent starts on its own.",
      image: "/og/06-automations.png",
    },
  },
  {
    pattern: /^\/apps(\/.*)?$/,
    meta: {
      title: "Apps - UseAgent",
      description: "Connect the tools your team already uses.",
      image: "/og/07-apps.png",
    },
  },
  {
    pattern: /^\/settings(\/.*)?$/,
    meta: {
      title: "Settings - UseAgent",
      description: "Manage your workspace, providers, infrastructure, usage, secrets, and team.",
      image: "/og/08-customize.png",
    },
  },
  {
    pattern: /^\/secrets(\/.*)?$/,
    meta: {
      title: "Secrets - UseAgent",
      description: "Encrypted org secrets injected into every sandbox this workspace boots.",
      image: "/og/08-customize.png",
    },
  },
  {
    pattern: /^\/artifacts(\/.*)?$/,
    meta: {
      title: "Artifacts - UseAgent",
      description: "Files and outputs from your agent runs.",
      image: "/og/10-library.png",
    },
  },
  {
    pattern: /^\/tasks(\/.*)?$/,
    meta: {
      title: "Tasks - UseAgent",
      description: "Durable, org-scoped tasks grouped per project on a Kanban board.",
      image: "/og/10-library.png",
    },
  },
  {
    pattern: /^\/knowledge(\/.*)?$/,
    meta: {
      title: "Knowledge - UseAgent",
      description: "Facts and conventions UseAgent remembers across runs.",
      image: "/og/11-knowledge.png",
    },
  },
  {
    pattern: /^\/memory(\/.*)?$/,
    meta: {
      title: "Memory - UseAgent",
      description: "The team memory UseAgent recalls, captures, and can correct.",
      image: "/og/12-memory.png",
    },
  },
  {
    pattern: /^\/playbooks(\/.*)?$/,
    meta: {
      title: "Playbooks - UseAgent",
      description: "Structured procedures UseAgent follows as guidance for repeatable work.",
      image: "/og/13-playbooks.png",
    },
  },
  {
    pattern: /^\/review(\/.*)?$/,
    meta: {
      title: "Pull requests - UseAgent",
      description: "Open pull requests across your connected GitHub repositories.",
      image: "/og/14-reviews.png",
    },
  },
  {
    pattern: /^\/skills(\/.*)?$/,
    meta: {
      title: "Skills - UseAgent",
      description: "Reusable skills UseAgent follows for repeatable work.",
      image: "/og/15-skills.png",
    },
  },
  {
    pattern: /^\/learnings(\/.*)?$/,
    meta: {
      title: "Learnings - UseAgent",
      description: "Review proposed knowledge drafts and skill revisions before they go live.",
      image: "/og/17-learnings.png",
    },
  },
  {
    pattern: /^\/wiki(\/.*)?$/,
    meta: {
      title: "Wiki - UseAgent",
      description: "Published knowledge documents for your organization.",
      image: "/og/18-wiki.png",
    },
  },
  {
    pattern: /^\/session(\/.*)?$/,
    meta: {
      title: "Session - UseAgent",
      description: "Live coding session with AI agents in isolated sandboxes.",
      image: "/og/03-thread.png",
    },
  },
  {
    pattern: /^\/login(\/.*)?$/,
    meta: {
      title: "Sign in - UseAgent",
      description: "Sign in to your UseAgent workspace.",
      image: "/og/01-home.png",
    },
  },
  {
    pattern: /^\/signup(\/.*)?$/,
    meta: {
      title: "Sign up - UseAgent",
      description: "Create your UseAgent workspace account.",
      image: "/og/01-home.png",
    },
  },
];

function getBotResponse(request: NextRequest): NextResponse | null {
  const userAgent = request.headers.get("user-agent") ?? "";
  if (!BOT_USER_AGENTS.test(userAgent)) return null;

  const { pathname } = request.nextUrl;
  const match = ROUTE_METADATA.find(({ pattern }) => pattern.test(pathname));
  const meta: RouteMeta = match?.meta ?? {
    title: "UseAgent - one interface for every coding agent",
    description: "Run coding agents in isolated workspaces with durable context, automations, and audit trails.",
    image: "/og/01-home.png",
  };

  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  const origin = `${proto}://${host}`;
  const imageUrl = `${origin}${meta.image}`;
  const canonicalUrl = `${origin}${pathname}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${meta.title}</title>
  <meta name="description" content="${meta.description}" />
  <meta property="og:title" content="${meta.title}" />
  <meta property="og:description" content="${meta.description}" />
  <meta property="og:url" content="${canonicalUrl}" />
  <meta property="og:site_name" content="UseAgent" />
  <meta property="og:type" content="website" />
  <meta property="og:image" content="${imageUrl}" />
  <meta property="og:image:width" content="1600" />
  <meta property="og:image:height" content="900" />
  <meta property="og:image:alt" content="${meta.title}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${meta.title}" />
  <meta name="twitter:description" content="${meta.description}" />
  <meta name="twitter:image" content="${imageUrl}" />
</head>
<body>
  <h1>${meta.title}</h1>
  <p>${meta.description}</p>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

export function proxy(request: NextRequest): NextResponse {
  const response = routeResponse(request);
  if (response) return response;

  const botResponse = getBotResponse(request);
  if (botResponse) return botResponse;

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
    "/((?!api|v2|healthz|og/|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
