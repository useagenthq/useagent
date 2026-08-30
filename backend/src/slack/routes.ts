/**
 * Slack Events-API endpoint: `POST /api/slack/events`. Mirrors QM's
 * http-events.ts receiver, reframed onto Hono:
 *   1. read the RAW body (needed byte-for-byte for signature verification),
 *   2. verify the Slack request signature (401 on failure),
 *   3. answer the one-time `url_verification` challenge (synchronous),
 *   4. persist `event_callback`s in the durable inbox,
 *   5. ACK only after that commit succeeds.
 *
 * The route is also self-gated: with the adapter unconfigured it 404s, so it is
 * inert even if somehow mounted.
 */
import { Hono } from "hono";
import { slackConfig } from "../env";
import { slackEventIsEarlyNoop, type SlackEnvelope } from "./events";
import { classifySlackInboxEvent, persistSlackInboxEvent } from "./inbox";
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
    if (slackEventIsEarlyNoop(body)) return c.body(null, 200);
    // Slack gets a 200 only after the authenticated envelope and its resolved
    // identity commit. A DB failure intentionally returns 503 so Slack retries;
    // run acceptance, attachment downloads, and provider work remain async.
    const retryNum = c.req.header("x-slack-retry-num");
    if (retryNum) {
      console.log(
        `[slack] retry delivery (num ${retryNum}, reason ${c.req.header("x-slack-retry-reason") ?? "unknown"})`,
      );
    }
    try {
      const decision = await classifySlackInboxEvent(body);
      if (decision === "drop") return c.body(null, 200);
      await persistSlackInboxEvent(body, decision);
    } catch (error) {
      console.error("[slack] inbox persistence failed:", (error as Error).message);
      return c.json({ error: "slack_ingress_unavailable" }, 503);
    }
  }

  return c.body(null, 200);
});
