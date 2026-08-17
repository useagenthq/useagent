import { Hono } from "hono";
import type { AppEnv } from "../http";
import { auth } from "../auth";
import { orgScope } from "../middleware/org";
import { isMemoryScope, type MemoryScope } from "../memory/scope";
import { resolveChatProviderCredential } from "../provider-gateway/credentials";
import { chatModelCatalog } from "./models";
import { CHAT_SYSTEM_PROMPT } from "./prompt";
import { retrieveChatContext } from "./retrieve";
import { chatModel, streamChat, type ChatMessage } from "./stream";

/**
 * Lightweight Chat API (#122) - mounted at /api/chat. A NO-SANDBOX conversational
 * surface: talk to the model directly (instant, cheap), augmented with READ-ONLY
 * retrieval (org knowledge + published wiki + team memory). Distinct from the
 * Agent surface (/api/runs), which spins Daytona sandboxes.
 *
 * Tenancy is server-resolved by the universal auth adapter (index.ts); the
 * per-router `orgScope` below is house-style defense-in-depth (idempotent).
 */
export const chatRoutes = new Hono<AppEnv>();

chatRoutes.use("*", orgScope);

const MESSAGE_ROLES = new Set(["user", "assistant"]);

/** Validate the request's `messages` into a typed list, or null on any malformed
 *  entry / a history with no user turn. */
function parseMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: ChatMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const rec = entry as Record<string, unknown>;
    const role = rec.role;
    const content = rec.content;
    if (typeof role !== "string" || !MESSAGE_ROLES.has(role) || typeof content !== "string") {
      return null;
    }
    out.push({ role: role as ChatMessage["role"], content });
  }
  return out.some((m) => m.role === "user") ? out : null;
}

/** The REAL better-auth user for this request (null when anonymous / dev-org
 *  fallback), so personal-scope retrieval fails closed - `c.get("userId")` is
 *  filled with the dev user by the org middleware and must not be trusted here. */
async function authedUserId(headers: Headers): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers });
    return session?.user.id ?? null;
  } catch {
    return null;
  }
}

// GET /api/chat/models - the served model catalog + current default. Powers the
// Chat page's real model picker (honest: the UI renders exactly what the key
// serves). Harmless when the LLM is unconfigured; the list is informational.
chatRoutes.get("/models", (c) => c.json(chatModelCatalog()));

// POST /api/chat - SSE. Body: { messages: [{role, content}], model?, memoryScope? }.
// Emits `event: context` (citations) once, then a burst of `event: delta` text
// tokens, then `event: done`. A failure surfaces as `event: error`. NO sandbox.
//
// Built as a raw ReadableStream (not hono streamSSE) so we own every header -
// `no-transform` + `X-Accel-Buffering: no` stop proxies buffering the stream
// (the same SSE-hygiene the runs `/events` route relies on).
chatRoutes.post("/", async (c) => {
  let body: { messages?: unknown; model?: unknown; memoryScope?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const messages = parseMessages(body.messages);
  if (!messages) {
    return c.json({ error: "`messages` must be a non-empty array of {role, content}" }, 400);
  }

  const model =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : chatModel();
  if (!chatModelCatalog().models.some((candidate) => candidate.value === model)) {
    return c.json({ error: "model_not_allowed" }, 400);
  }
  const memoryScope: MemoryScope = isMemoryScope(body.memoryScope) ? body.memoryScope : "org";

  const orgId = c.get("orgId");
  const userId = await authedUserId(c.req.raw.headers);

  // Resolve the OpenRouter credential BYOK-first: a customer's connected key
  // wins over the house key, so their own quota is spent (and an invalid
  // customer key surfaces its real error rather than re-billing the house).
  const resolved = await resolveChatProviderCredential({ orgId, userId });
  if (!resolved) {
    return c.json({ error: "chat is not configured (no OpenRouter credential)" }, 503);
  }
  console.info(`[chat] org ${orgId} served by ${resolved.source}`);

  // Retrieve against the latest user message; the surface is stateless so a
  // synthetic per-org session id stands in for the memory provenance threadId.
  const query = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const threadId = `chat:${orgId}`;

  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (frame: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          /* controller already closed (client gone) */
        }
      };
      const sendEvent = (event: string, data: unknown): void =>
        send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Prime headers/first bytes, then heartbeat idle streams.
      send(": open\n\n");
      const heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
      heartbeat.unref?.();

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      if (signal.aborted) return cleanup();
      signal.addEventListener("abort", cleanup);

      void (async () => {
        try {
          // Read-only retrieval first (best-effort, never throws) so the UI can
          // show honest Sources before the answer streams.
          const context = await retrieveChatContext({ orgId, userId, query, memoryScope, threadId });
          if (closed) return;
          sendEvent("context", { citations: context.citations });

          const system = context.block ? `${CHAT_SYSTEM_PROMPT}\n\n${context.block}` : CHAT_SYSTEM_PROMPT;
          const llmMessages: ChatMessage[] = [{ role: "system", content: system }, ...messages];
          for await (const delta of streamChat(llmMessages, model, resolved.value, signal)) {
            if (closed) return;
            sendEvent("delta", { delta });
          }
          if (!closed) sendEvent("done", {});
        } catch {
          if (!closed) sendEvent("error", { error: "chat request failed" });
        } finally {
          cleanup();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

export default chatRoutes;
