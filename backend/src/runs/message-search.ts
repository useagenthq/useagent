/**
 * Message search behind `GET /api/runs/search`: finds the words someone
 * remembers from a thread in what was said in it, the prompts people typed and
 * the replies the agent gave (`runs.prompt` and `runs.summary`, the two texts a
 * thread shows as messages). Postgres full-text search with the `simple`
 * configuration, so no language's stemming or stop words apply, and every
 * query word matches as a word prefix: "deplo stag" finds "Deploy to staging".
 *
 * Only threads the workspace's thread list shows are searched: the member's
 * workspace, user-created runs (`origin is null`) under a user-created thread
 * root, and never a gateway child session, which folds under its parent turn
 * instead of showing as a message.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { sqlStateOf } from "../db/pg-errors";
import { CHILD_SESSION_IDEMPOTENCY_PREFIX } from "./repo";

export const MESSAGE_SEARCH_MAX_QUERY_CHARS = 200;
export const MESSAGE_SEARCH_DEFAULT_LIMIT = 10;
export const MESSAGE_SEARCH_MAX_LIMIT = 25;

/** Every keystroke in the search box can ask; a search that scans too long is
 *  cut off instead of holding a connection. */
const MESSAGE_SEARCH_STATEMENT_TIMEOUT_MS = 5_000;
/** SQLSTATE 57014: the statement ran into its statement_timeout. */
const QUERY_CANCELED = "57014";

/** ts_headline options: one fragment of about a sentence around the matched
 *  words (fragment mode keeps the words before the first match), no markup. */
const SNIPPET_OPTIONS = 'StartSel="", StopSel="", MaxFragments=1, MaxWords=20, MinWords=10, ShortWord=0';

export type MessageRole = "user" | "agent";

export interface MessageMatch {
  readonly threadId: string;
  readonly runId: string;
  /** The thread root's prompt, the text its title comes from. */
  readonly threadPrompt: string;
  /** Who said it: the person's prompt or the agent's reply. */
  readonly role: MessageRole;
  /** A short part of the message around the matched words. */
  readonly snippet: string;
  readonly createdAt: Date;
}

export class MessageSearchTimeoutError extends Error {
  constructor() {
    super("message search took too long");
    this.name = "MessageSearchTimeoutError";
  }
}

/**
 * The newest matching message of each thread, newest thread first, at most
 * `limit` threads. A message matches when it holds every word of the query.
 * A query with no searchable words (only punctuation) matches nothing.
 */
export async function searchThreadMessages(
  orgId: string,
  query: string,
  limit: number = MESSAGE_SEARCH_DEFAULT_LIMIT,
): Promise<MessageMatch[]> {
  const childSessionKeys = `${CHILD_SESSION_IDEMPOTENCY_PREFIX}:%`;
  try {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('statement_timeout', ${String(MESSAGE_SEARCH_STATEMENT_TIMEOUT_MS)}, true)`,
      );
      // The query goes through the same parser as the messages, then each of
      // its words is quoted as a prefix term (`'word':*`), so no character the
      // person types is ever read as tsquery syntax. Each word must also appear
      // in the text as written (ILIKE, wildcards escaped): every full-text match
      // passes that cheap check, so only the rows that do pay for to_tsvector.
      return tx.execute(sql`
        with words as (
          select replace(word, '\\', '\\\\') as word
          from unnest(tsvector_to_array(to_tsvector('simple', ${query}))) as word
        ), search as (
          select
            to_tsquery('simple', string_agg(
              '''' || replace(word, '''', '''''') || ''':*',
              ' & '
            )) as terms,
            array_agg('%' || replace(replace(word, '%', '\\%'), '_', '\\_') || '%') as patterns
          from words
        ), messages as (
          select
            message.id,
            message.thread_id,
            message.created_at,
            message.thread_seq,
            said.role,
            said.body,
            said.position
          from runs message
          inner join runs root
            on root.org_id = message.org_id
            and root.id = message.thread_id
            and root.origin is null
          cross join lateral (
            values ('agent', message.summary, 0), ('user', message.prompt, 1)
          ) as said(role, body, position)
          cross join search
          where message.org_id = ${orgId}
            and message.origin is null
            and search.terms is not null
            and said.body is not null
            and said.body ilike all (search.patterns)
            and to_tsvector('simple', said.body) @@ search.terms
            and not exists (
              select 1 from commands child_command
              where child_command.run_id = message.id
                and child_command.idempotency_key like ${childSessionKeys}
            )
        ), newest_per_thread as (
          select distinct on (thread_id) *
          from messages
          order by thread_id, created_at desc, thread_seq desc, position
        ), page as (
          select *
          from newest_per_thread
          order by created_at desc, id desc
          limit ${limit}
        )
        select
          page.thread_id,
          page.id as run_id,
          root.prompt as thread_prompt,
          page.role,
          ts_headline('simple', page.body, search.terms, ${SNIPPET_OPTIONS}) as snippet,
          page.created_at
        from page
        inner join runs root on root.id = page.thread_id
        cross join search
        order by page.created_at desc, page.id desc
      `);
    });
    return rows.map((row) => ({
      threadId: row.thread_id as string,
      runId: row.run_id as string,
      threadPrompt: row.thread_prompt as string,
      role: row.role as MessageRole,
      snippet: (row.snippet as string).replace(/\s+/g, " ").trim(),
      createdAt: new Date(row.created_at as string | Date),
    }));
  } catch (error) {
    if (sqlStateOf(error) === QUERY_CANCELED) throw new MessageSearchTimeoutError();
    throw error;
  }
}
