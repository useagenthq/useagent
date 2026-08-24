import type {
  CanonicalChildState,
  CanonicalChildUsage,
  CanonicalCommand,
  CanonicalPlanEntry,
} from "./canonical";

/** Bump only when a native bridge changes its command/frame wire shape. */
export const NATIVE_BRIDGE_PROTOCOL_VERSION = 2 as const;

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
  | { readonly kind: "message.delta"; readonly messageId: string; readonly text: string }
  | { readonly kind: "message.completed"; readonly messageId: string }
  | { readonly kind: "reasoning.delta"; readonly messageId: string; readonly text: string }
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
export class NativeBridgeDeltaAccumulator {
  #messageText = new Map<string, string>();
  #reasoningText = new Map<string, string>();

  durable(body: NativeBridgeFrameBody): NativeBridgeFrameBody {
    if (body.kind !== "message.delta" && body.kind !== "reasoning.delta") return body;
    const target = body.kind === "message.delta" ? this.#messageText : this.#reasoningText;
    const cumulative = `${target.get(body.messageId) ?? ""}${body.text}`;
    target.set(body.messageId, cumulative);
    return { ...body, text: cumulative };
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
