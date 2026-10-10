import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { REQUIRED_API_COMPAT } from "../security";

/**
 * A local control plane for the desktop smoke test.
 *
 * The desktop shell is a thin client of the hosted control plane, so a smoke
 * test that must stay deterministic in CI cannot depend on the production
 * plane. This server speaks just enough of the plane's contract for the shell
 * to boot, render the sign-in screen, and complete a real useagent:// sign-in:
 * the compatibility manifest, the login and desktop-auth pages, the PKCE code
 * exchange, and the session endpoints. Every response matches the shape the
 * real plane sends, including the script nonces the shell's content policy
 * requires on HTML responses.
 *
 * The PKCE state is captured the same way the real plane captures it: the
 * system browser opens /desktop-auth with the state and code challenge, and
 * only the native app that started the request can present a matching code
 * verifier at the exchange.
 *
 * The server is plain node:http so the smoke runner can execute it under Node,
 * where Playwright's WebSocket transport is reliable, and the unit tests can
 * still exercise the same module under bun.
 */

/** One sign-in request the system browser opened at /desktop-auth. */
export type PlaneAuthorization = {
  state: string;
  codeChallenge: string;
  identifier: string;
};

export type MockPlane = {
  origin: string;
  /** Sign-in requests captured from the system browser, oldest first. */
  authorizations: readonly PlaneAuthorization[];
  /** True once the desktop app completed the code exchange for a captured request. */
  exchanged: boolean;
  close: () => Promise<void>;
};

const DIGEST = "sha256:9060298717e1b1a6687586e6a0e57c8b8d6e4e2c8a9b0f1d3e5c7a9b8d6e4e2c";

/** The PKCE check the control plane performs on the code exchange: the SHA-256
 * digest of the verifier must equal the captured challenge, compared as bytes
 * so base64url padding differences cannot fail a genuine pair. */
export function verifyPkce(codeChallenge: string, codeVerifier: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(codeVerifier)) return false;
  const digest = createHash("sha256").update(codeVerifier).digest();
  const expected = Buffer.from(codeChallenge, "base64url");
  return expected.length === digest.length && Buffer.compare(expected, digest) === 0;
}

/** The deep link token the plane hands the browser: base64url JSON of state plus identifier. */
export function deepLinkToken(authorization: PlaneAuthorization): string {
  return Buffer.from(JSON.stringify({ state: authorization.state, identifier: authorization.identifier })).toString("base64url");
}

function pageNonce(): string {
  return randomBytes(24).toString("base64url");
}

function htmlPage(title: string, body: string, script: string | null): [string, Record<string, string>] {
  const value = pageNonce();
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
</head>
<body>
${body}
${script === null ? "" : `<script nonce="${value}">
${script}
</script>`}
</body>
</html>`;
  return [
    page,
    {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `script-src 'nonce-${value}'`,
    },
  ];
}

function loginPage(): [string, Record<string, string>] {
  return htmlPage(
    "Sign in - UseAgent",
    `<main>
  <section aria-label="Desktop sign-in">
    <h1>Sign in to UseAgent</h1>
    <p>Continue in your browser to sign in. You will return here when finished.</p>
    <button id="continue-in-browser" type="button">Continue in browser</button>
    <p id="runner-status" role="status">Checking runner</p>
  </section>
</main>`,
    `const bridge = window.useagentDesktop;
const status = document.getElementById("runner-status");
if (bridge) {
  bridge.runnerStatus().then((update) => { status.textContent = "Runner is " + update.state; });
  document.getElementById("continue-in-browser").addEventListener("click", () => {
    bridge.openExternal(new URL("/desktop-auth", window.location.origin).href);
    status.textContent = "Finish sign-in in your browser";
  });
} else {
  status.textContent = "Desktop bridge unavailable";
}`,
  );
}

function desktopAuthPage(): [string, Record<string, string>] {
  return htmlPage(
    "Connect the UseAgent desktop app",
    `<main>
  <h1>Approve the desktop sign-in</h1>
  <p>This page belongs to the desktop smoke test. The test completes the sign-in itself.</p>
</main>`,
    null,
  );
}

function workspacePage(): [string, Record<string, string>] {
  return htmlPage(
    "UseAgent",
    `<main>
  <h1>Smoke workspace</h1>
  <p id="workspace-name">Smoke Workspace</p>
</main>`,
    null,
  );
}

function userRecord(): Record<string, unknown> {
  return {
    id: "user-smoke",
    email: "smoke@useagent.test",
    emailVerified: true,
    name: "Smoke user",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function respond(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, headers);
  response.end(body);
}

export async function startMockPlane(): Promise<MockPlane> {
  const authorizations: PlaneAuthorization[] = [];
  let exchanged = false;
  const sessionValue = `smoke-session-${randomBytes(12).toString("hex")}`;

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => respond(response, 500, "Mock plane failure."));
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const authenticated = (request.headers.cookie ?? "").includes(sessionValue);
    if (request.method === "GET" && url.pathname === "/api/config") {
      respond(response, 200, JSON.stringify({
        release: { apiCompat: REQUIRED_API_COMPAT },
        runner: { image: { ref: "ghcr.io/useagent/local-sandbox", digest: DIGEST } },
      }), { "content-type": "application/json" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/login") {
      const [body, headers] = loginPage();
      respond(response, 200, body, headers);
      return;
    }
    if (request.method === "GET" && url.pathname === "/desktop-auth") {
      const state = url.searchParams.get("state") ?? "";
      const codeChallenge = url.searchParams.get("code_challenge") ?? "";
      if (
        url.searchParams.get("client_id") !== "electron" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        !/^[A-Za-z0-9]{16}$/.test(state) ||
        !/^[A-Za-z0-9_-]{43}=?$/.test(codeChallenge)
      ) {
        respond(response, 400, "Invalid desktop sign-in request.");
        return;
      }
      authorizations.push({ state, codeChallenge, identifier: `smoke-authorization-${randomBytes(12).toString("hex")}` });
      const [body, headers] = desktopAuthPage();
      respond(response, 200, body, headers);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/electron/token") {
      if (request.headers["electron-origin"] !== "useagent:/") {
        respond(response, 403, JSON.stringify({ message: "Desktop token exchange requires the native app." }), { "content-type": "application/json" });
        return;
      }
      const body = await readJson(request);
      const match =
        typeof body?.token === "string" && typeof body?.state === "string" && typeof body?.code_verifier === "string"
          ? authorizations.find((authorization) => authorization.identifier === body.token && authorization.state === body.state)
          : undefined;
      if (!match || !verifyPkce(match.codeChallenge, body?.code_verifier as string)) {
        respond(response, 400, JSON.stringify({ message: "Invalid desktop token exchange." }), { "content-type": "application/json" });
        return;
      }
      exchanged = true;
      respond(response, 200, JSON.stringify({ token: sessionValue, user: userRecord() }), {
        "content-type": "application/json",
        "set-cookie": `better-auth.session_token=${sessionValue}; Path=/; HttpOnly; Max-Age=3600; SameSite=Lax`,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/auth/get-session") {
      respond(response, 200, JSON.stringify(authenticated ? {
        session: {
          id: "session-smoke",
          userId: "user-smoke",
          activeOrganizationId: "org-smoke",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ipAddress: "127.0.0.1",
          userAgent: "desktop-smoke",
        },
        user: userRecord(),
      } : null), { "content-type": "application/json" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/auth/organization/list") {
      if (!authenticated) {
        respond(response, 401, "");
        return;
      }
      respond(response, 200, JSON.stringify([{ id: "org-smoke", name: "Smoke Workspace" }]), { "content-type": "application/json" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      const [body, headers] = workspacePage();
      respond(response, 200, body, headers);
      return;
    }
    respond(response, 404, "");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    get authorizations() {
      return authorizations;
    },
    get exchanged() {
      return exchanged;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function readJson(request: IncomingMessage): Promise<{ token?: unknown; state?: unknown; code_verifier?: unknown } | null> {
  const body = await new Promise<string>((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += String(chunk);
    });
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });
  if (body === "") return null;
  try {
    return JSON.parse(body) as { token?: unknown; state?: unknown; code_verifier?: unknown };
  } catch {
    return null;
  }
}
