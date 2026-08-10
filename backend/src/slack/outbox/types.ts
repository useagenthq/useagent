import type { SlackErrorClass, SlackOutboxKind } from "../../db/schema";

// ---------------------------------------------------------------------------
// Boundary types for the durable Slack outbox. Kept separate from persistence
// (repo.ts) and delivery (delivery.ts) so enqueue callers depend only on shapes.
// ---------------------------------------------------------------------------

export type PostMessagePayload = {
  readonly channel: string;
  readonly text: string;
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

/** A request to durably enqueue one outbound Slack call. `idempotencyKey` makes
 *  enqueue idempotent AND bounds delivery to once per logical message. */
export type SlackOutboxEnqueue =
  | { readonly kind: "post_message"; readonly idempotencyKey: string; readonly payload: PostMessagePayload }
  | { readonly kind: "add_reaction"; readonly idempotencyKey: string; readonly payload: AddReactionPayload }
  | { readonly kind: "upload_file"; readonly idempotencyKey: string; readonly payload: UploadFilePayload };

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
