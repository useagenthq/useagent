import type {
  CanonicalAgentEvent,
  CanonicalEventKind,
} from "./canonical";

/** OpenCode native frame subset consumed by the canonical translator. */
export interface OpenCodeFrame {
  eventId: string;
  seq: number;
  provider: string;
  eventType: string;
  native: {
    sessionId: string | null;
    parentSessionId: string | null;
    messageId: string | null;
    partId: string | null;
    callId: string | null;
  };
  payload: unknown;
}

/** Durable step projection consumed alongside the native frame stream. */
export interface OpenCodeStep {
  id: string;
  run_id?: string;
  idx: number;
  kind: string;
  label?: string | null;
  chip?: string | null;
  code_json?: string | null;
}

export interface TranslateCtx {
  runId: string;
  threadId: string;
  engine?: string;
  ts?: (seq: number) => number;
}

export interface Disposition {
  sourceId: string;
  kind: string;
  provider: string;
  produced: CanonicalEventKind[];
  suppressed?: string;
}

export interface TranslateResult {
  events: CanonicalAgentEvent[];
  accounting: Disposition[];
}
