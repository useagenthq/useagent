import { index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { runs } from "./runs";

// ---------------------------------------------------------------------------
// Slack adapter — maps a Slack thread to the useAgent run that ROOTED it, so a
// later reply in that Slack thread becomes a `parent_run_id` follow-up (shared
// thread, clean prompts). One row per Slack thread the bot has engaged; the
// composite key is the Slack thread's identity `(channel, thread root ts)`.
// ---------------------------------------------------------------------------

// Maps a Slack WORKSPACE (team id) to its tenant. `user_id` is the provisioning
// operator retained for compatibility; event attribution never uses it. A
// sender must have a separate slack_users row before accessing private data.
// Ingress fails CLOSED for an unmapped workspace.
export const slackWorkspaces = pgTable("slack_workspaces", {
  teamId: text("team_id").primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Verified Slack sender -> product user mapping. Workspace ownership alone is
// never enough to impersonate its operator: private resources require this
// per-sender identity, while unmapped senders may still create org-only runs.
export const slackUsers = pgTable(
  "slack_users",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => slackWorkspaces.teamId, { onDelete: "cascade" }),
    slackUserId: text("slack_user_id").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.slackUserId] })],
);

export const slackThreads = pgTable(
  "slack_threads",
  {
    teamId: text("team_id").notNull(),
    channel: text("channel").notNull(),
    threadTs: text("thread_ts").notNull(),
    rootRunId: text("root_run_id")
      .notNull()
      .references(() => runs.id),
    orgId: text("org_id").notNull(),
    // Slack message ts of the run CARD (Block Kit) posted into this thread, so
    // later progress/completion updates target the SAME message via chat.update.
    // Null until the card is posted (or when the card post failed and the plain
    // reply is used instead). One card per rooted Slack thread.
    cardTs: text("card_ts"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.channel, t.threadTs] })],
);

export const slackRunResponses = pgTable(
  "slack_run_responses",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    teamId: text("team_id").notNull(),
    channel: text("channel").notNull(),
    threadTs: text("thread_ts").notNull(),
    nativeStreamTs: text("native_stream_ts"),
    nativeStreamMode: text("native_stream_mode").$type<"task_update" | "plan">(),
    fallbackMessageTs: text("fallback_message_ts"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.teamId, t.channel, t.threadTs] }),
    index("idx_slack_run_responses_run").on(t.runId),
    index("idx_slack_run_responses_thread").on(t.teamId, t.channel, t.threadTs),
  ],
);

// ---------------------------------------------------------------------------
// Durable Slack connector outbox (north star "transactional connector outbox").
// Outbound Slack calls (the run-completion reply, the receipt reaction) are
// enqueued here as durable rows — a backend restart must not lose an undelivered
// reply. A delivery worker claims due rows, calls Slack, and on failure records
// a classified error + bounded exponential backoff; after `max_attempts` the row
// dead-letters. Slack 429s honor Retry-After. `idempotency_key` (UNIQUE)
// deduplicates enqueue and bounds delivery to once per logical message.
// ---------------------------------------------------------------------------

export type SlackOutboxState = "pending" | "delivering" | "delivered" | "dead";
// `upload_file` delivers a run-produced artifact into the thread. New rows carry
// only an immutable artifact id; legacy rows may still carry a staged path.
// `post_card`/`update_card` post + advance the Block Kit run card in place (the
// card ts is stored on slack_threads). `kind` is a text column, so a new kind
// needs no migration.
export type SlackOutboxKind =
  | "post_message"
  | "add_reaction"
  | "upload_file"
  | "post_card"
  | "update_card"
  | "set_session_status"
  | "start_stream"
  | "append_stream"
  | "stop_stream";
/** Classified delivery failure — drives retry vs dead-letter and observability. */
export type SlackErrorClass = "rate_limited" | "transient" | "permanent";

export const slackOutbox = pgTable(
  "slack_outbox",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    kind: text("kind").$type<SlackOutboxKind>().notNull(),
    /** Bounded JSON of the Slack call arguments (channel/text/threadTs, …). */
    payload: text("payload").notNull(),
    state: text("state").$type<SlackOutboxState>().notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    /** Earliest time a pending row may be (re)delivered — backoff / Retry-After. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    errorClass: text("error_class").$type<SlackErrorClass>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The delivery worker claims due rows by (state, next_attempt_at).
    index("idx_slack_outbox_due").on(t.state, t.nextAttemptAt),
  ],
);
