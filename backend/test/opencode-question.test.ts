import { afterEach, describe, expect, test } from "bun:test";
import {
  OpenCodeQuestionError,
  parseOpenCodeQuestionRequest,
  replyToOpenCodeQuestion,
  validateOpenCodeQuestionAnswers,
} from "../src/engines/opencode-question";
import {
  forgetOpenCodeThreadServer,
  rememberOpenCodeThreadServer,
} from "../src/engines/opencode-runtime";
import { createRun } from "../src/runs/repo";

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
          return Response.json([request]);
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
        answers: [["Staging"]],
        signal: AbortSignal.timeout(5_000),
      }),
    ).toEqual({ alreadyAnswered: false });
    expect(postedBody).toEqual({ answers: [["Staging"]] });

    // A lost-response retry is served by the durable receipt; it must not POST
    // the one-shot provider reply a second time.
    expect(
      await replyToOpenCodeQuestion({
        runId,
        threadId,
        sessionId: "ses_test",
        questionId: "que_test",
        answers: [["Staging"]],
        signal: AbortSignal.timeout(5_000),
      }),
    ).toEqual({ alreadyAnswered: true });
  });
});
