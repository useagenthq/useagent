// Ported from reference bot (Apache-2.0): src/kiro_crew/messaging/transport.py
// Ported from reference bot (Apache-2.0): src/kiro_crew/messaging/renderer.py
//
// The channel-neutral connector contracts: a `Transport` (inbound/outbound for a
// messaging surface), a `Renderer` (maps abstract output events onto that
// surface), and the `TransportCapabilities` a surface negotiates. A new surface =
// implement these two interfaces (see connectors/email/). Translated Python →
// TypeScript; names/shapes kept close to the source so the two stay diff-able.
//
// Deviations from the source (intentional): the approval event `on_prompt_choice`
// / `PROMPT_CHOICE` and the kiro-cli `steer_consumed` event are OMITTED — no
// approval flow exists yet (a later piece) and steer has no consumer here.

// ---------------------------------------------------------------------------
// Capabilities — what a messaging surface can do.
// ---------------------------------------------------------------------------

/** What a messaging channel can do. Boolean flags gate features; the integer
 *  parameters capture where channels differ quantitatively (so a Renderer can
 *  chunk / degrade rather than assume a single shape); `supportsProactiveSend`
 *  gates proactive / delayed sends. Defaults (see `defaultCapabilities`) are the
 *  conservative WhatsApp-like floor so a surface that forgets to declare a
 *  capability degrades safely rather than over-promising. */
export interface TransportCapabilities {
  streaming: boolean;
  edit: boolean;
  reactions: boolean;
  files: boolean;
  richBlocks: boolean;
  threads: boolean;
  /** Slack ~40000, Telegram 4096, Discord 2000, WhatsApp 4096. */
  maxMessageChars: number;
  /** Interactive choices per prompt (WhatsApp reply buttons = 3). */
  maxButtons: number;
  /** WhatsApp: false outside the 24h window. */
  supportsProactiveSend: boolean;
}

/** The conservative capability floor, with per-surface overrides. */
export function defaultCapabilities(
  overrides: Partial<TransportCapabilities> = {},
): TransportCapabilities {
  return {
    streaming: false,
    edit: false,
    reactions: false,
    files: false,
    richBlocks: false,
    threads: false,
    maxMessageChars: 4096,
    maxButtons: 3,
    supportsProactiveSend: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Value objects.
// ---------------------------------------------------------------------------

/** A user-configured outbound destination exposed to a dashboard. */
export interface ConfiguredChannelTarget {
  targetId: string;
  label: string;
  available: boolean;
  unavailableReason: string;
}

/** A normalized inbound message, channel-agnostic. */
export interface InboundMessage {
  channelType: string; // "slack" | "telegram" | "email" | ...
  userId: string;
  conversationId: string;
  text: string;
  threadId?: string | null;
  attachments: unknown[];
  isMention: boolean;
}

// ---------------------------------------------------------------------------
// Transport — the inbound/outbound contract for a messaging surface.
// ---------------------------------------------------------------------------

/** Channel-neutral inbound/outbound contract for a messaging channel. A new
 *  channel = implement this interface + an inbound adapter, with zero change to
 *  the shared run-feed core (connectors/runFeed.ts). Mirrors reference bot's
 *  `MessagingTransport` ABC. */
export interface Transport {
  readonly channelType: string;
  readonly capabilities: TransportCapabilities;

  // -- Tier-1 core (every transport) --------------------------------------
  /** Send `content` to a conversation; return a platform message id. */
  sendMessage(
    conversationId: string,
    content: string,
    threadId?: string | null,
  ): Promise<string>;
  /** Resolve a direct-conversation id for `userId` (`open_dm` equiv). */
  resolveConversation(userId: string): Promise<string>;
  /** Return prior messages for a conversation/thread. */
  fetchHistory(
    conversationId: string,
    threadId?: string | null,
  ): Promise<InboundMessage[]>;

  // -- Lifecycle (default no-ops; override as needed) ---------------------
  connect?(): Promise<void>;
  maintain?(): Promise<void>;
  disconnect?(): Promise<void>;

  // -- Dashboard-configured outbound targets ------------------------------
  configuredTargets?(): ConfiguredChannelTarget[];
  resolveConfiguredTarget?(
    targetId: string,
  ): Promise<[conversationId: string, threadId: string | null] | null>;

  // -- Inbound adapter ----------------------------------------------------
  /** Handle a raw platform event: ack → filter → authorize → normalize →
   *  dispatch to the turn handler. */
  receive(rawEnvelope: unknown): Promise<void>;
  /** Return true iff `msg` is allowed to drive a turn. Implementations MUST be
   *  deny-by-default: an unconfigured transport authorizes nobody. */
  authorize(msg: InboundMessage): boolean;
}

// ---------------------------------------------------------------------------
// Abstract output events + the Renderer contract.
// ---------------------------------------------------------------------------

export const TEXT_CHUNK = "text_chunk";
export const THINKING = "thinking";
export const TOOL_CALL = "tool_call";
export const COMPACTION = "compaction";
export const DONE = "done";

export type OutputKind =
  | typeof TEXT_CHUNK
  | typeof THINKING
  | typeof TOOL_CALL
  | typeof COMPACTION
  | typeof DONE;

/** A channel-neutral output event, consumed by a `Renderer`. */
export interface OutputEvent {
  kind: OutputKind;
  text?: string; // text_chunk / thinking
  toolCallId?: string; // tool_call
  title?: string; // tool_call (tool name / "Running: X")
  toolKind?: string; // tool_call (e.g. "edit"/"execute" — drives phase emoji)
  toolPurpose?: string; // tool_call (human-readable purpose)
  contextUsagePct?: number; // compaction
  stopReason?: string; // done
}

/** Maps abstract `OutputEvent`s onto a transport's native surface. Mirrors
 *  reference bot's `Renderer` ABC (approval `on_prompt_choice` omitted). Handlers may
 *  be sync or async. */
export interface Renderer {
  readonly channelType: string;
  /** Called once before the event stream begins. Optional. */
  onTurnStart?(): Promise<void> | void;
  /** Render a streamed assistant text chunk. */
  onTextChunk(text: string): Promise<void> | void;
  /** Render a reasoning/thinking update. */
  onThinking(text: string): Promise<void> | void;
  /** Render a tool call. Mirrors the native uniform tool-call semantics: each
   *  call marks the previous task complete and starts a new in-progress task. */
  onToolCall(
    toolCallId: string,
    title: string,
    toolKind?: string,
    toolPurpose?: string,
  ): Promise<void> | void;
  /** Render a context-compaction notice. */
  onCompaction(contextUsagePct: number): Promise<void> | void;
  /** Finalize the turn (close any open stream). */
  onDone(stopReason?: string): Promise<void> | void;
}

/** Route `event` to the matching `on*` handler. Port of the Python
 *  `Renderer.dispatch`; throws on an unknown kind. */
export async function dispatch(
  renderer: Renderer,
  event: OutputEvent,
): Promise<void> {
  switch (event.kind) {
    case TEXT_CHUNK:
      await renderer.onTextChunk(event.text ?? "");
      return;
    case THINKING:
      await renderer.onThinking(event.text ?? "");
      return;
    case TOOL_CALL:
      await renderer.onToolCall(
        event.toolCallId ?? "",
        event.title ?? "",
        event.toolKind ?? "",
        event.toolPurpose ?? "",
      );
      return;
    case COMPACTION:
      await renderer.onCompaction(event.contextUsagePct ?? 0);
      return;
    case DONE:
      await renderer.onDone(event.stopReason ?? "");
      return;
    default:
      throw new Error(
        `unknown output event kind: ${String((event as OutputEvent).kind)}`,
      );
  }
}

/** Split `text` into chunks no longer than `maxChars`. Pure helper for Renderers
 *  honoring `capabilities.maxMessageChars`. Returns `[]` for empty input; a
 *  non-positive `maxChars` disables chunking. Port of Python `chunk_text`. */
export function chunkText(text: string, maxChars: number): string[] {
  if (!text) return [];
  if (maxChars <= 0 || text.length <= maxChars) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}
