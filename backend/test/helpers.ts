/**
 * Shared test helpers. Everything runs IN-PROCESS against the Hono app's
 * `fetch` handler (imported from src/index) — no port is bound, no server is
 * spawned. The top-level `await seedDev()` in src/index runs once on import, so
 * the dev org/user/member are present by the time any test executes. No demo
 * skills or knowledge are seeded — those surfaces start empty.
 */
import server from "../src/index";

// better-auth resolves same-origin against this base; a trusted Origin header is
// required on its mutating routes (CSRF guard), so default it on every call.
export const BASE = "http://localhost:3211";
export const ORIGIN = "http://localhost:3200";

export interface ApiInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  cookies?: string; // Cookie header value
}

/** Call the app in-process. JSON-encodes an object body automatically. */
export function fetchApi(path: string, init: ApiInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    ...(init.headers ?? {}),
  };
  let body: string | FormData | undefined;
  if (init.body !== undefined) {
    if (init.body instanceof FormData) {
      body = init.body;
    } else if (typeof init.body === "string") {
      body = init.body;
    } else {
      body = JSON.stringify(init.body);
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }
  }
  if (init.cookies) headers["cookie"] = init.cookies;
  return Promise.resolve(server.fetch(
    new Request(BASE + path, { method: init.method ?? "GET", headers, body }),
  ));
}

/** GET/POST/etc. helper that returns { status, json }. */
export async function json<T = any>(
  path: string,
  init: ApiInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetchApi(path, init);
  const text = await res.text();
  let body: T;
  try {
    body = text ? JSON.parse(text) : (null as T);
  } catch {
    body = text as unknown as T;
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Cookie jar — accumulates Set-Cookie across requests, renders a Cookie header.
// ---------------------------------------------------------------------------

export class CookieJar {
  private store = new Map<string, string>();

  absorb(res: Response): void {
    // Headers.getSetCookie() returns every Set-Cookie individually.
    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [];
    for (const sc of setCookies) {
      const first = sc.split(";")[0]!;
      const eq = first.indexOf("=");
      if (eq === -1) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (value === "" || value === "deleted") this.store.delete(name);
      else this.store.set(name, value);
    }
  }

  header(): string {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  has(name: string): boolean {
    return this.store.has(name);
  }
}

// ---------------------------------------------------------------------------
// SSE reader — collect parsed frames from a streaming Response until `done`.
// ---------------------------------------------------------------------------

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Read an SSE Response body, returning every parsed event once a `done` event
 * arrives (or the stream ends / the timeout fires). Cancels the reader on exit.
 */
export async function readSse(
  res: Response,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  if (!res.body) return events;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  const pump = async (): Promise<void> => {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseFrame(frame);
        if (parsed) {
          events.push(parsed);
          if (parsed.event === "done") return;
        }
      }
    }
  };

  try {
    await Promise.race([
      pump(),
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ]);
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

function parseFrame(frame: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat comment
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0 && event === "message") return null;
  return { event, data: dataLines.join("\n") };
}

/** A short unique suffix for test data (emails, org slugs, external ids). */
export function uid(prefix = "t"): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Auth: create a real authenticated org session (sign-up → create org → set
// active). Returns the cookie jar plus the resolved org id. This is the ONLY
// sanctioned way for a test to scope requests to a tenant — org is resolved
// server-side from the session, never from a forged x-org-id header.
// ---------------------------------------------------------------------------

export interface OrgSession {
  jar: CookieJar;
  cookies: string;
  orgId: string;
  email: string;
}

export async function createOrgSession(label = "org"): Promise<OrgSession> {
  const email = `${uid(label)}@example.com`;
  const jar = new CookieJar();

  const signUp = await fetchApi("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: `User ${label}`, email, password: "password-1234" },
  });
  if (signUp.status !== 200) throw new Error(`sign-up failed: ${signUp.status}`);
  jar.absorb(signUp);

  const create = await fetchApi("/api/auth/organization/create", {
    method: "POST",
    cookies: jar.header(),
    body: { name: `Org ${label}`, slug: uid("slug") },
  });
  if (create.status !== 200) throw new Error(`org create failed: ${create.status}`);
  jar.absorb(create);
  const created = await create.json() as { id?: string; organization?: { id?: string } };
  const orgId = created.id ?? created.organization?.id;
  if (!orgId) throw new Error("org create returned no id");

  const setActive = await fetchApi("/api/auth/organization/set-active", {
    method: "POST",
    cookies: jar.header(),
    body: { organizationId: orgId },
  });
  if (setActive.status !== 200) throw new Error(`set-active failed: ${setActive.status}`);
  jar.absorb(setActive);

  return { jar, cookies: jar.header(), orgId, email };
}

/** Poll `fn` until it returns truthy or the timeout elapses. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 8_000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
