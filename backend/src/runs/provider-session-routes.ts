import { parseProviderSessionBinding } from "@useagent/agent-harness/canonical";
import type { Hono } from "hono";
import { resolveProviderDriverForSession } from "../engines";
import {
  OpenCodeQuestionError,
  replyToOpenCodeQuestion,
} from "../engines/opencode-question";
import { providerSessionAuthIsCurrent } from "../engines/provider-session-authority";
import { replyToRuntimeApproval, RuntimeApprovalError } from "../engines/runtime-approval";
import { replyToRuntimeQuestion } from "../engines/runtime-question";
import type { AppEnv } from "../http";
import { strictOrgSecretRedactor } from "../secrets/store";
import { getRunForOrg } from "./repo";

/** Register control traffic for a provider session already running inside a
 * turn. These replies unblock the resident session; they never enqueue a run. */
export function registerProviderSessionRoutes(routes: Hono<AppEnv>): void {
  routes.post("/:id/questions/:questionId/reply", async (c) => {
    const run = await getRunForOrg(c.get("orgId"), c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    const binding = parseProviderSessionBinding(run.providerSession);
    const authCurrent = binding
      ? await providerSessionAuthIsCurrent({ binding, orgId: run.orgId, userId: run.userId })
      : false;
    const boundDriver = binding && authCurrent
      ? resolveProviderDriverForSession(run.engine, binding, binding.authEpoch)
      : undefined;
    const runtimeSession = boundDriver?.descriptor.protocol.name === "t3-orchestration";
    const opencodeSession = binding
      ? boundDriver?.provider === "opencode" &&
        boundDriver.descriptor.protocol.name === "opencode-server"
      : run.engine === "opencode";
    if (!runtimeSession && !opencodeSession) {
      return c.json({ error: "questions_not_supported", engine: run.engine }, 409);
    }
    const sessionId = binding?.nativeSessionId ?? run.engineSessionId;
    if (run.status !== "running" || !sessionId) {
      return c.json({ error: "question_session_not_active" }, 409);
    }
    let body: { answers?: unknown; resources?: unknown; attachments?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (body.resources !== undefined || body.attachments !== undefined) {
      return c.json({ error: "question replies cannot add run resources" }, 400);
    }
    try {
      const reply = runtimeSession ? replyToRuntimeQuestion : replyToOpenCodeQuestion;
      const redact = await strictOrgSecretRedactor(run.orgId);
      const result = await reply({
        runId: run.id,
        threadId: run.threadId,
        sessionId,
        questionId: c.req.param("questionId"),
        answers: body.answers,
        signal: c.req.raw.signal,
        redact,
      });
      return c.json({ ok: true, already_answered: result.alreadyAnswered });
    } catch (error) {
      if (error instanceof OpenCodeQuestionError) {
        return c.json({ error: error.code, message: error.message }, error.status);
      }
      console.error(`[question] reply failed for run ${run.id}:`, error);
      return c.json({ error: "question_reply_failed" }, 502);
    }
  });

  routes.post("/:id/approvals/:requestId/reply", async (c) => {
    const run = await getRunForOrg(c.get("orgId"), c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    const binding = parseProviderSessionBinding(run.providerSession);
    const authCurrent = binding
      ? await providerSessionAuthIsCurrent({ binding, orgId: run.orgId, userId: run.userId })
      : false;
    const boundDriver = binding && authCurrent
      ? resolveProviderDriverForSession(run.engine, binding, binding.authEpoch)
      : undefined;
    if (
      run.status !== "running" ||
      !binding ||
      boundDriver?.descriptor.protocol.name !== "t3-orchestration"
    ) {
      return c.json({ error: "approval_session_not_active" }, 409);
    }
    let body: { decision?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const result = await replyToRuntimeApproval({
        runId: run.id,
        threadId: run.threadId,
        sessionId: binding.nativeSessionId,
        requestId: c.req.param("requestId"),
        decision: body.decision,
        signal: c.req.raw.signal,
      });
      return c.json({ ok: true, already_answered: result.alreadyAnswered });
    } catch (error) {
      if (error instanceof RuntimeApprovalError) {
        return c.json({ error: error.code, message: error.message }, error.status);
      }
      console.error(`[approval] reply failed for run ${run.id}:`, error);
      return c.json({ error: "approval_reply_failed" }, 502);
    }
  });
}
