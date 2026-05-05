/**
 * Slack Events-API endpoint: `POST /api/slack/events`. Mirrors QM's
 * http-events.ts receiver, reframed onto Hono:
 *   1. read the RAW body (needed byte-for-byte for signature verification),
 *   2. verify the Slack request signature (401 on failure),
 *   3. answer the one-time `url_verification` challenge,
 *   4. hand `event_callback`s to the ingest logic and 200 fast (< Slack's 3s).
 *
 * The route is also self-gated: with the adapter unconfigured it 404s, so it is
 * inert even if somehow mounted.
 */
import { Hono } from "hono";
import { slackConfig } from "../env";
import { handleSlackEvent, type SlackEnvelope } from "./events";
import { verifySlackSignature } from "./verify";

export const slackRoutes = new Hono();

slackRoutes.post("/events", async (c) => {
  const config = slackConfig();
  if (!config) return c.json({ error: "slack adapter disabled" }, 404);

  const raw = await c.req.text();
  const valid = verifySlackSignature({
    signingSecret: config.signingSecret,
    signature: c.req.header("x-slack-signature"),
    timestamp: c.req.header("x-slack-request-timestamp"),
    body: raw,
  });
  if (!valid) return c.json({ error: "invalid_signature" }, 401);

  let body: SlackEnvelope;
  try {
    body = JSON.parse(raw) as SlackEnvelope;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // URL verification handshake (Slack posts this once when you set the URL).
  if (body.type === "url_verification") {
    return c.json({ challenge: body.challenge });
  }

  if (body.type === "event_callback") {
    try {
      await handleSlackEvent(body);
    } catch (err) {
      // Swallow: a handler failure must not make Slack retry-storm us.
      console.error("[slack] event handler error:", (err as Error).message);
    }
  }

  return c.body(null, 200);
});
