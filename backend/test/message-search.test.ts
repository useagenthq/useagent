import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { commands, runs } from "../src/db/schema";
import { MESSAGE_SEARCH_MAX_LIMIT } from "../src/runs/message-search";
import { createOrgSession, json } from "./helpers";

// `GET /api/runs/search` (message search in the ⌘K palette), through the real
// route and database: what matches, which message wins in a thread, and which
// threads a member can reach.

interface MessageMatchWire {
  thread_id: string;
  run_id: string;
  thread_prompt: string;
  role: "user" | "agent";
  snippet: string;
  created_at: string;
}

interface SearchResponse {
  matches: MessageMatchWire[];
}

interface SeedRun {
  readonly orgId: string;
  readonly prompt: string;
  readonly summary?: string | null;
  readonly threadId?: string;
  readonly parentRunId?: string;
  readonly origin?: string | null;
  readonly status?: "queued" | "running" | "completed" | "failed";
  /** Seconds before now; larger is older. */
  readonly ageSeconds: number;
}

async function seedRun(run: SeedRun): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(runs).values({
    id,
    orgId: run.orgId,
    userId: null,
    prompt: run.prompt,
    summary: run.summary ?? null,
    model: "test-model",
    engine: "mock",
    status: run.status ?? "completed",
    origin: run.origin ?? null,
    parentRunId: run.parentRunId ?? null,
    threadId: run.threadId ?? id,
    createdAt: sql`now() - ${run.ageSeconds}::int * interval '1 second'`,
    updatedAt: sql`now() - ${run.ageSeconds}::int * interval '1 second'`,
  });
  return id;
}

function search(query: string, cookies: string, extra = "") {
  return json<SearchResponse>(`/api/runs/search?q=${encodeURIComponent(query)}${extra}`, {
    cookies,
  });
}

describe("message search", () => {
  test("finds a reply by words in any order, as word prefixes, and says where it was said", async () => {
    const session = await createOrgSession("message-search-reply");
    const root = await seedRun({
      orgId: session.orgId,
      prompt: "Fix the flaky checkout test\nIt fails on CI about once a day.",
      summary: "Done, the test passes now.",
      ageSeconds: 300,
    });
    const reply = await seedRun({
      orgId: session.orgId,
      prompt: "Why did it fail?",
      summary:
        "The checkout test raced the payment webhook. I made it wait for the webhook before it asserts the order total, so the test no longer depends on timing.",
      threadId: root,
      parentRunId: root,
      ageSeconds: 200,
    });

    const response = await search("WEBHOOK pay", session.cookies);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.matches).toHaveLength(1);
    const [match] = response.body.matches;
    expect(match).toMatchObject({
      thread_id: root,
      run_id: reply,
      thread_prompt: "Fix the flaky checkout test\nIt fails on CI about once a day.",
      role: "agent",
    });
    // The words before the first match come along, not only what follows it.
    expect(match!.snippet).toStartWith("The checkout test raced the payment webhook.");
    expect(match!.snippet.length).toBeLessThan(260);
    expect(Number.isFinite(Date.parse(match!.created_at))).toBe(true);

    // Every word has to be in the same message: "webhook" is in the reply and
    // "flaky" only in the root prompt, so no message holds both.
    expect((await search("webhook flaky", session.cookies)).body.matches).toEqual([]);
    // A word is matched from its start, never from its middle.
    expect((await search("hook", session.cookies)).body.matches).toEqual([]);
  });

  test("finds what the person typed, and returns one message per thread, the newest", async () => {
    const session = await createOrgSession("message-search-newest");
    const root = await seedRun({
      orgId: session.orgId,
      prompt: "Draft the staging rollout plan",
      summary: "Here is a plan for the staging rollout.",
      ageSeconds: 600,
    });
    const followup = await seedRun({
      orgId: session.orgId,
      prompt: "Move the staging rollout to Friday",
      summary: "Moved it.",
      threadId: root,
      parentRunId: root,
      ageSeconds: 500,
    });
    await seedRun({
      orgId: session.orgId,
      prompt: "Unrelated thread about invoices",
      summary: "Nothing about it.",
      ageSeconds: 100,
    });

    const response = await search("staging rollout", session.cookies);
    expect(response.status).toBe(200);
    expect(response.body.matches).toHaveLength(1);
    expect(response.body.matches[0]).toMatchObject({
      thread_id: root,
      run_id: followup,
      role: "user",
      snippet: "Move the staging rollout to Friday",
    });

    // Within one turn, the reply comes after the prompt it answers.
    const both = await seedRun({
      orgId: session.orgId,
      prompt: "Check the Kestrel cache",
      summary: "The Kestrel cache is warm.",
      ageSeconds: 50,
    });
    expect((await search("kestrel", session.cookies)).body.matches).toEqual([
      expect.objectContaining({ thread_id: both, run_id: both, role: "agent" }),
    ]);
  });

  test("orders threads by their newest match and honours the limit", async () => {
    const session = await createOrgSession("message-search-order");
    const threads: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      threads.push(
        await seedRun({
          orgId: session.orgId,
          prompt: `Quarterly report number ${index}`,
          ageSeconds: 1_000 - index,
        }),
      );
    }
    const newestFirst = threads.toReversed();

    const byDefault = await search("quarterly", session.cookies);
    expect(byDefault.body.matches.map((match) => match.thread_id)).toEqual(newestFirst.slice(0, 10));

    const three = await search("quarterly", session.cookies, "&limit=3");
    expect(three.body.matches.map((match) => match.thread_id)).toEqual(newestFirst.slice(0, 3));

    const capped = await search("quarterly", session.cookies, "&limit=500");
    expect(capped.body.matches).toHaveLength(MESSAGE_SEARCH_MAX_LIMIT);
    const garbage = await search("quarterly", session.cookies, "&limit=abc");
    expect(garbage.body.matches).toHaveLength(10);
  });

  test("never returns another workspace's threads", async () => {
    const owner = await createOrgSession("message-search-owner");
    const other = await createOrgSession("message-search-other");
    const mine = await seedRun({
      orgId: owner.orgId,
      prompt: "Rotate the Albatross signing key",
      ageSeconds: 60,
    });
    await seedRun({
      orgId: other.orgId,
      prompt: "Rotate the Albatross signing key too",
      ageSeconds: 30,
    });

    const ownerResults = await search("albatross", owner.cookies);
    expect(ownerResults.body.matches.map((match) => match.thread_id)).toEqual([mine]);
    const otherResults = await search("albatross", other.cookies);
    expect(otherResults.body.matches.map((match) => match.thread_id)).not.toContain(mine);
    expect(otherResults.body.matches).toHaveLength(1);
  });

  test("leaves out the runs the thread list leaves out", async () => {
    const session = await createOrgSession("message-search-hidden");
    // An automation's thread and an internal canary are not in the thread list.
    await seedRun({
      orgId: session.orgId,
      prompt: "Pelican digest from the automation",
      origin: "product:automation",
      ageSeconds: 90,
    });
    await seedRun({
      orgId: session.orgId,
      prompt: "Pelican canary",
      origin: "internal:canary",
      ageSeconds: 80,
    });
    // A gateway child session folds under its parent turn; it is not a message.
    const visible = await seedRun({
      orgId: session.orgId,
      prompt: "Plan the Pelican launch",
      summary: "Planned.",
      ageSeconds: 70,
    });
    const child = await seedRun({
      orgId: session.orgId,
      prompt: "Pelican subtask the agent wrote for a child session",
      threadId: visible,
      parentRunId: visible,
      ageSeconds: 10,
    });
    await db.insert(commands).values({
      id: crypto.randomUUID(),
      idempotencyKey: `child-session:${visible}:pelican`,
      orgId: session.orgId,
      actorId: null,
      kind: "run.create",
      runId: child,
      threadId: visible,
      payloadFingerprint: null,
      payload: null,
      state: "completed",
    });

    const response = await search("pelican", session.cookies);
    expect(response.body.matches).toEqual([
      expect.objectContaining({ thread_id: visible, run_id: visible, role: "user" }),
    ]);
  });

  test("reads quotes, backslashes and tsquery operators as plain words", async () => {
    const session = await createOrgSession("message-search-syntax");
    const thread = await seedRun({
      orgId: session.orgId,
      prompt: "Why won't the build start? It says C:\\tools\\make is missing (or broken) & stops. See /tmp/build_log.txt at 100%.",
      ageSeconds: 40,
    });

    for (const query of ["won't", "C:\\tools", "(or", "broken) &", "!build | start:*", "/tmp/build_log.txt", "100%", "'"]) {
      const response = await search(query, session.cookies);
      expect(response.status, `${query}: ${JSON.stringify(response.body)}`).toBe(200);
      if (query === "'") expect(response.body.matches).toEqual([]);
      else expect(response.body.matches.map((match) => match.thread_id)).toEqual([thread]);
    }
    const punctuation = await search("&& !! ::", session.cookies);
    expect(punctuation.status).toBe(200);
    expect(punctuation.body.matches).toEqual([]);
  });

  test("rejects a missing, blank or oversized query", async () => {
    const session = await createOrgSession("message-search-invalid");
    for (const path of ["/api/runs/search", "/api/runs/search?q=", "/api/runs/search?q=%20%20"]) {
      const response = await json<{ error: string }>(path, { cookies: session.cookies });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("q is required");
    }
    const long = await search("a".repeat(201), session.cookies);
    expect(long.status).toBe(400);
    expect((long.body as unknown as { error: string }).error).toBe("q must be at most 200 characters");
  });
});
