import { enqueueCapture } from "../memory/capture-outbox";
import { assessCaptureSalience } from "../memory/capture-salience";
import { resolveScopedMemory, type MemoryScope } from "../memory/scope";

// ---------------------------------------------------------------------------
// Chat capture parity (memory self-improvement item 7). The lightweight Chat
// surface (#122) used to be read-only against memory; a completed exchange now
// becomes durable org memory under the SAME governance as runs: the shared
// salience gate, the same scope resolution (org pool / personal fail-closed),
// and the same durable outbox. Chat has no run row, so the capture uses a
// synthetic `chat:<uuid>` id — memory_outbox.run_id is plain text with no FK,
// so no schema change is needed; the Memory Hub admin list (which joins `runs`)
// simply does not show chat captures. Evidence marks the chat origin
// (source="chat") so recalled turns are honest about where they came from.
// Memory is best-effort everywhere: this NEVER throws into the chat stream.
// ---------------------------------------------------------------------------

/** One completed chat exchange to capture. `prompt` is the latest user turn,
 *  `summary` the full streamed assistant answer. */
export interface ChatExchange {
  readonly orgId: string;
  /** The REAL authenticated user (null = anonymous), so personal scope fails
   *  closed exactly like runs. */
  readonly userId: string | null;
  readonly memoryScope: MemoryScope;
  readonly prompt: string;
  readonly summary: string;
  readonly model: string;
}

/**
 * Enqueue a completed chat exchange through the run-capture outbox, gated by the
 * same salience heuristic and scoped to the same org/memory pools. Returns the
 * capture id when enqueued, null when gated out (not salient, memory disabled,
 * fail-closed personal) — and null on ANY failure: a memory problem must never
 * fail the chat exchange.
 */
export async function captureChatExchange(exchange: ChatExchange): Promise<string | null> {
  try {
    if (!assessCaptureSalience({ prompt: exchange.prompt, summary: exchange.summary }).salient) {
      return null;
    }
    const captureId = `chat:${crypto.randomUUID()}`;
    // Same per-org provenance session the chat retrieval path uses (routes.ts).
    const plan = resolveScopedMemory({
      orgId: exchange.orgId,
      userId: exchange.userId,
      threadId: `chat:${exchange.orgId}`,
      id: captureId,
      memoryScope: exchange.memoryScope,
    });
    if (!plan?.writePool) return null;
    await enqueueCapture(
      captureId,
      plan.writePool.identity,
      {
        prompt: exchange.prompt,
        summary: exchange.summary,
        evidence: { source: "chat", status: "completed", model: exchange.model },
      },
      plan.scope,
    );
    return captureId;
  } catch (err) {
    console.warn("[chat] memory capture failed (exchange unaffected):", err);
    return null;
  }
}
