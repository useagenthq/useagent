import type {
  CanonicalChildState,
  CanonicalChildUsage,
  CanonicalCommand,
  CanonicalPlanEntry,
} from "./canonical";

/** Bump only when a native bridge changes its command/frame wire shape. */
export const NATIVE_BRIDGE_PROTOCOL_VERSION = 3 as const;

export type NativeBridgeCommand =
  | { readonly kind: "prompt"; readonly text: string; readonly model?: string }
  | { readonly kind: "steer"; readonly text: string }
  | { readonly kind: "follow_up"; readonly text: string }
  | { readonly kind: "cancel"; readonly reason: string };

export type NativeBridgeFrameBody =
  | { readonly kind: "turn.started" }
  | { readonly kind: "turn.completed"; readonly stopReason?: string }
  | { readonly kind: "turn.failed"; readonly error: string; readonly stopReason?: string }
  | { readonly kind: "message.started"; readonly messageId: string }
  | { readonly kind: "message.delta"; readonly messageId: string; readonly text: string; readonly segment?: number; readonly authoritative?: boolean }
  | { readonly kind: "message.authoritative"; readonly messageId: string; readonly text: string }
  | { readonly kind: "message.completed"; readonly messageId: string }
  | { readonly kind: "reasoning.delta"; readonly messageId: string; readonly text: string; readonly segment?: number; readonly authoritative?: boolean }
  | { readonly kind: "reasoning.authoritative"; readonly messageId: string; readonly text: string }
  | { readonly kind: "plan.updated"; readonly entries: readonly CanonicalPlanEntry[] }
  | { readonly kind: "commands.updated"; readonly commands: readonly CanonicalCommand[] }
  | {
      readonly kind: "tool.started";
      readonly toolCallId: string;
      readonly name: string;
      readonly input?: unknown;
    }
  | {
      readonly kind: "tool.progress";
      readonly toolCallId: string;
      readonly name?: string;
      readonly preview?: string;
    }
  | {
      readonly kind: "tool.completed";
      readonly toolCallId: string;
      readonly name?: string;
      readonly status: "ok" | "error";
      readonly preview?: string;
      readonly error?: string;
    }
  | {
      readonly kind: "usage.updated";
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly costUsd?: number;
    }
  | {
      readonly kind: "child.started";
      readonly childId: string;
      readonly title?: string;
      readonly launchToolCallId?: string;
      readonly state?: CanonicalChildState;
    }
  | {
      readonly kind: "child.updated";
      readonly childId: string;
      readonly status: string;
      readonly state?: CanonicalChildState;
    }
  | {
      readonly kind: "child.completed";
      readonly childId: string;
      readonly status: "ok" | "error";
      readonly result?: string;
      readonly state?: CanonicalChildState;
    };

export interface NativeBridgeFrame {
  readonly protocolVersion: typeof NATIVE_BRIDGE_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly seq: number;
  readonly ts: number;
  readonly body: NativeBridgeFrameBody;
}

/** Assigns one monotonic sequence to every native frame before product mapping. */
export class NativeBridgeSequencer {
  #seq = 0;

  constructor(
    private readonly sessionId: string,
    private readonly now: () => number = Date.now,
  ) {}

  frame(body: NativeBridgeFrameBody): NativeBridgeFrame {
    return {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: ++this.#seq,
      ts: this.now(),
      body,
    };
  }
}

/** Converts provider-native incremental deltas into cumulative durable
 * revisions. Live streaming still publishes the original delta; persistence
 * upserts one coherent message/reasoning row per message id. */
export const NATIVE_BRIDGE_DURABLE_TEXT_BYTES = 4_096;

interface DurableTextSegment {
  index: number;
  text: string;
  bytes: number;
}

/** Converts provider-native incremental deltas into bounded cumulative durable
 * revisions. Each segment remains safely below the provider-event JSON cap even
 * for worst-case escaped control text; consumers recompose segments by message
 * id. Live streaming still publishes the original unsegmented delta. */
export class NativeBridgeDeltaAccumulator {
  #messageText = new Map<string, DurableTextSegment>();
  #reasoningText = new Map<string, DurableTextSegment>();
  #encoder = new TextEncoder();

  #append(
    body: Extract<NativeBridgeFrameBody, { kind: "message.delta" | "reasoning.delta" }>,
    target: Map<string, DurableTextSegment>,
  ): readonly NativeBridgeFrameBody[] {
    let segment = target.get(body.messageId) ?? { index: 0, text: "", bytes: 0 };
    const output: NativeBridgeFrameBody[] = [];
    let changed = false;
    for (const character of body.text) {
      const bytes = this.#encoder.encode(character).byteLength;
      if (segment.bytes > 0 && segment.bytes + bytes > NATIVE_BRIDGE_DURABLE_TEXT_BYTES) {
        if (changed) output.push({ ...body, text: segment.text, segment: segment.index });
        segment = { index: segment.index + 1, text: "", bytes: 0 };
        changed = false;
      }
      segment.text += character;
      segment.bytes += bytes;
      changed = true;
    }
    if (changed) output.push({ ...body, text: segment.text, segment: segment.index });
    target.set(body.messageId, segment);
    return output;
  }

  #replace(
    body: Extract<NativeBridgeFrameBody, { kind: "message.authoritative" | "reasoning.authoritative" }>,
    target: Map<string, DurableTextSegment>,
  ): readonly NativeBridgeFrameBody[] {
    const previousLastIndex = target.get(body.messageId)?.index ?? -1;
    target.delete(body.messageId);
    const kind = body.kind === "message.authoritative" ? "message.delta" : "reasoning.delta";
    const replacement = this.#append(
      { kind, messageId: body.messageId, text: body.text, authoritative: true },
      target,
    );
    const authoritativeReplacement = replacement.length > 0
      ? replacement
      : [{ kind, messageId: body.messageId, text: "", segment: 0, authoritative: true } as const];
    const replacementLastIndex = target.get(body.messageId)?.index ?? -1;
    const tombstones: NativeBridgeFrameBody[] = [];
    for (let index = replacementLastIndex + 1; index <= previousLastIndex; index++) {
      tombstones.push({ kind, messageId: body.messageId, text: "", segment: index, authoritative: true });
    }
    return [...authoritativeReplacement, ...tombstones];
  }

  durable(body: NativeBridgeFrameBody): readonly NativeBridgeFrameBody[] {
    if (body.kind === "message.delta") return this.#append(body, this.#messageText);
    if (body.kind === "reasoning.delta") return this.#append(body, this.#reasoningText);
    if (body.kind === "message.authoritative") return this.#replace(body, this.#messageText);
    if (body.kind === "reasoning.authoritative") return this.#replace(body, this.#reasoningText);
    return [body];
  }
}

export function bridgeChildUsage(
  usage: Readonly<Record<string, unknown>> | undefined,
): CanonicalChildUsage | undefined {
  if (!usage) return undefined;
  const entries = Object.entries(usage).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}
