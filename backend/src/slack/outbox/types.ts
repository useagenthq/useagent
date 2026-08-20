import type { SlackErrorClass, SlackOutboxKind } from "../../db/schema";

// ---------------------------------------------------------------------------
// Boundary types for the durable Slack outbox. Kept separate from persistence
// (repo.ts) and delivery (delivery.ts) so enqueue callers depend only on shapes.
// ---------------------------------------------------------------------------

export type PostMessagePayload = {
  readonly channel: string;
  /** Ordered message texts, posted sequentially into the same thread (a long
   *  reply is CHUNKED, not truncated - see ../chunk.ts). New rows always carry
   *  `chunks`; `text` remains readable for pre-migration rows. */
  readonly chunks?: readonly string[];
  readonly text?: string;
  readonly threadTs?: string;
};

export type AddReactionPayload = {
  readonly channel: string;
  readonly timestamp: string;
  readonly name: string;
};

/** Deliver a run-produced artifact into a thread. New rows reference immutable
 * shared artifact storage; stagedPath remains readable for pre-migration rows. */
export type UploadFilePayload = {
  readonly channel: string;
  readonly threadTs?: string;
  readonly filename: string;
  readonly title?: string;
  readonly artifactId?: string;
  readonly stagedPath?: string;
  readonly size: number;
};

/** Post the Block Kit RUN CARD into a thread and persist its message ts on
 *  slack_threads so later updates target it. `rootRunId` keys the thread row the
 *  ts is stored on; `text` is the plain-text notification/fallback string. */
export type PostCardPayload = {
  readonly channel: string;
  readonly threadTs: string;
  readonly rootRunId: string;
  readonly blocks: readonly unknown[];
  readonly text: string;
};

/** Advance the run card IN PLACE (chat.update) to its final state. The card ts is
 *  resolved from slack_threads at delivery (it may not exist yet at enqueue). When
 *  no card ts is found or the update fails permanently, the delivery falls back to
 *  posting the answer as CHUNKED plain messages so the reply is NEVER lost. */
export type UpdateCardPayload = {
  readonly channel: string;
  readonly threadTs: string;
  readonly rootRunId: string;
  readonly blocks: readonly unknown[];
  readonly text: string;
  /** The full answer, chunked - the plain-text fallback when no card ts exists. */
  readonly fallbackChunks: readonly string[];
};

/** A request to durably enqueue one outbound Slack call. `idempotencyKey` makes
 *  enqueue idempotent AND bounds delivery to once per logical message. */
export type SlackOutboxEnqueue =
  | { readonly kind: "post_message"; readonly idempotencyKey: string; readonly payload: PostMessagePayload }
  | { readonly kind: "add_reaction"; readonly idempotencyKey: string; readonly payload: AddReactionPayload }
  | { readonly kind: "upload_file"; readonly idempotencyKey: string; readonly payload: UploadFilePayload }
  | { readonly kind: "post_card"; readonly idempotencyKey: string; readonly payload: PostCardPayload }
  | { readonly kind: "update_card"; readonly idempotencyKey: string; readonly payload: UpdateCardPayload };

/** How a claimed row transitioned after a delivery attempt. */
export type SlackDeliveryOutcome =
  | { readonly status: "delivered" }
  | { readonly status: "retry"; readonly errorClass: SlackErrorClass; readonly nextAttemptAt: Date }
  | { readonly status: "dead"; readonly errorClass: SlackErrorClass };

export interface ProcessResult {
  readonly delivered: number;
  readonly retried: number;
  readonly dead: number;
}

export type { SlackErrorClass, SlackOutboxKind };
