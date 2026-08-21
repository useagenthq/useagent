import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  OpenCodeQuestionError,
  parseOpenCodeQuestionRequest,
  redactProviderQuestionPayload,
  replyToOpenCodeQuestion,
  validateOpenCodeQuestionAnswers,
} from "../src/engines/opencode-question";
import {
  forgetOpenCodeThreadServer,
  rememberOpenCodeThreadServer,
} from "../src/engines/opencode-runtime";
import { db } from "../src/db/client";
import { providerEvents } from "../src/db/schema";
import { createRun } from "../src/runs/repo";
import { createSecretRedactor } from "../src/secrets/redact";

const servers: Bun.Server<unknown>[] = [];
const cachedThreads: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const threadId of cachedThreads.splice(0)) forgetOpenCodeThreadServer(threadId);
});

const request = {
  id: "que_test",
  sessionID: "ses_test",
  questions: [
    {
      header: "Target",
      question: "Which environment should I use?",
      options: [
        { label: "Staging", description: "Use the staging environment" },
        { label: "Production", description: "Use the production environment" },
      ],
      multiple: false,
      custom: false,
    },
  ],
  tool: { messageID: "msg_test", callID: "call_test" },
} as const;

describe("OpenCode native questions", () => {
  test("redacts question content while preserving native routing identifiers", () => {
    const secret = "SYNTHETIC_QUESTION_SECRET_123456";
    const payload = redactProviderQuestionPayload(
      {
        id: "que_stable",
        sessionID: "ses_stable",
        questions: [{
          header: `Header ${secret}`,
          question: `Use ${secret}?`,
          options: [{ label: secret, description: `Token ${secret}` }],
        }],
        tool: { messageID: "msg_stable", callID: "call_stable" },
      },
      createSecretRedactor([
        secret,
        "que_stable",
        "ses_stable",
        "msg_stable",
        "call_stable",
      ]),
    );

    expect(payload).toMatchObject({
      id: "que_stable",
      sessionID: "ses_stable",
      tool: { messageID: "msg_stable", callID: "call_stable" },
    });
    expect(JSON.stringify(payload)).not.toContain(secret);
  });

  test("parses the provider contract and validates option answers", () => {
    const parsed = parseOpenCodeQuestionRequest(request);
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error("expected a parsed question request");
    expect(validateOpenCodeQuestionAnswers(parsed, [["Staging"]])).toEqual([["Staging"]]);
    expect(() => validateOpenCodeQuestionAnswers(parsed, [["Other"]])).toThrow(
      OpenCodeQuestionError,
    );
  });

  test("answers the resident session and records an idempotent durable receipt", async () => {
    const secret = "SYNTHETIC_QUESTION_ANSWER_SECRET_123456";
    const secretRequest = {
      ...request,
      questions: [{ ...request.questions[0], custom: true }],
    };
    const runId = crypto.randomUUID();
    const threadId = runId;
    cachedThreads.push(threadId);
    await createRun({
      id: runId,
      prompt: "deploy this",
      model: "test-model",
      engine: "opencode",
      orgId: "org-skynet-dev",
      userId: null,
      parentRunId: null,
      threadId,
      repos: [],
      memoryScope: "org",
    });

    let postedBody: unknown = null;
    const server = Bun.serve({
      port: 0,
      fetch: async (incoming) => {
        const url = new URL(incoming.url);
        expect(incoming.headers.get("x-daytona-preview-token")).toBe("preview-token");
        expect(url.searchParams.get("directory")).toBe("/workspace");
        if (incoming.method === "GET" && url.pathname === "/question") {
          return Response.json([secretRequest]);
        }
        if (incoming.method === "POST" && url.pathname === "/question/que_test/reply") {
          postedBody = await incoming.json();
          return Response.json(true);
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    rememberOpenCodeThreadServer(threadId, {
      sandboxId: "sandbox-test",
      baseUrl: server.url.toString().replace(/\/$/, ""),
      token: "preview-token",
      workdir: "/workspace",
    });

    expect(
      await replyToOpenCodeQuestion({
        runId,
        threadId,
        sessionId: "ses_test",
        questionId: "que_test",
        answers: [[secret]],
        signal: AbortSignal.timeout(5_000),
        redact: createSecretRedactor([secret]),
      }),
    ).toEqual({ alreadyAnswered: false });
    expect(postedBody).toEqual({ answers: [[secret]] });

    const [receipt] = await db
      .select({ payload: providerEvents.payload })
      .from(providerEvents)
      .where(eq(providerEvents.id, `pe_${runId}_que_test_replied`))
      .limit(1);
    expect(receipt?.payload).not.toContain(secret);
    expect(receipt?.payload).toContain("<redacted>");

    // A lost-response retry is served by the durable receipt; it must not POST
    // the one-shot provider reply a second time.
    expect(
      await replyToOpenCodeQuestion({
        runId,
        threadId,
        sessionId: "ses_test",
        questionId: "que_test",
        answers: [[secret]],
        signal: AbortSignal.timeout(5_000),
        redact: createSecretRedactor([secret]),
      }),
    ).toEqual({ alreadyAnswered: true });
  });
});
