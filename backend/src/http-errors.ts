import type { Env, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createSecretRedactor } from "./secrets/redact";

/** Some paths carry a credential (a preview view's signed capability): the
 * logged path keeps its shape with the credential scrubbed. */
const pathRedactor = createSecretRedactor([]);

/**
 * Give an app's last-resort answers the JSON shape every route already uses:
 * an unknown path is `404 {error: "not_found"}` and an error no route caught
 * is `500 {error: "internal_error"}`, logged with its method and path. Hono's
 * defaults are plain text, which a client reading the body as JSON fails on a
 * second time. An `HTTPException` (thrown by Hono middleware on purpose) keeps
 * the response it carries. Sub-apps mounted with `route()` that set no handler
 * of their own fall through to these.
 */
export function installJsonErrorHandlers<E extends Env>(app: Hono<E>, surface: string): void {
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    console.error(`[${surface}] ${c.req.method} ${pathRedactor.text(c.req.path)} failed:`, error);
    return c.json({ error: "internal_error" }, 500);
  });
}
