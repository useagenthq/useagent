import type { NativeBridgeFrame } from "@useagent/agent-harness/bridge";
import { ACP_COMMANDS_EVENT_TYPE } from "@useagent/agent-harness/canonical";
import type { ProviderEventInput } from "../runs/provider-events";
import type { EngineRunContext } from "./types";

/** Project a bridge frame onto the existing durable provider-event grammar so
 * replay/live/canonicalization keep one source of truth. Tool updates reuse one
 * stable id and therefore upsert; child lifecycle keeps distinct boundaries. */
export function piBridgeProviderEvent(
  ctx: Pick<EngineRunContext, "runId" | "threadId">,
  frame: NativeBridgeFrame,
): ProviderEventInput {
  const base = {
    runId: ctx.runId,
    threadId: ctx.threadId ?? ctx.runId,
    provider: "pi",
    nativeSessionId: frame.sessionId,
  };
  const body = frame.body;
  switch (body.kind) {
    case "message.delta":
      return {
        ...base,
        id: `pi:${frame.sessionId}:message:${body.messageId}:${frame.seq}`,
        eventType: "part.text",
        nativeMessageId: body.messageId,
        payload: { text: body.text, bridgeSeq: frame.seq },
      };
    case "reasoning.delta":
      return {
        ...base,
        id: `pi:${frame.sessionId}:reasoning:${body.messageId}:${frame.seq}`,
        eventType: "part.reasoning",
        nativeMessageId: body.messageId,
        payload: { text: body.text, bridgeSeq: frame.seq },
      };
    case "tool.started":
    case "tool.progress":
    case "tool.completed": {
      const terminal = body.kind === "tool.completed";
      const errored = terminal && body.status === "error";
      return {
        ...base,
        id: `pi:${frame.sessionId}:tool:${body.toolCallId}`,
        eventType: terminal ? `part.tool.${errored ? "error" : "completed"}` : "part.tool",
        nativeCallId: body.toolCallId,
        payload: {
          tool: body.name,
          input: body.kind === "tool.started" ? body.input : undefined,
          state: {
            status: body.kind === "tool.started" ? "running" : terminal ? body.status : "running",
            output: body.kind === "tool.started" ? undefined : body.preview,
            error: body.kind === "tool.completed" ? body.error : undefined,
          },
          bridgeSeq: frame.seq,
        },
      };
    }
    case "plan.updated":
      return {
        ...base,
        id: `pi:${frame.sessionId}:plan`,
        eventType: "part.tool",
        nativeCallId: "pi-plan",
        payload: { tool: "todowrite", input: { todos: body.entries }, bridgeSeq: frame.seq },
      };
    case "commands.updated":
      return {
        ...base,
        id: `pi:${frame.sessionId}:commands`,
        eventType: ACP_COMMANDS_EVENT_TYPE,
        payload: { source: "pi", generation: 1, commands: body.commands },
      };
    case "child.started":
    case "child.updated":
    case "child.completed": {
      const terminal = body.kind === "child.completed";
      return {
        ...base,
        id: `pi:${frame.sessionId}:child:${body.childId}:${terminal ? "done" : body.kind === "child.started" ? "start" : "progress"}`,
        eventType: terminal
          ? `part.subtask.${body.status === "error" ? "error" : "completed"}`
          : "part.subtask",
        nativeCallId: body.kind === "child.started"
          ? body.launchToolCallId ?? body.childId
          : body.childId,
        nativeParentSessionId: frame.sessionId,
        payload: {
          title: body.kind === "child.started" ? body.title : undefined,
          state: {
            ...(body.state ?? {}),
            status: body.kind === "child.completed" ? body.status : body.kind === "child.updated" ? body.status : "running",
            output: body.kind === "child.completed" ? body.result : body.state?.summary,
          },
          bridgeSeq: frame.seq,
        },
      };
    }
    case "usage.updated":
      return {
        ...base,
        id: `pi:${frame.sessionId}:usage`,
        eventType: "part.step-finish",
        nativeMessageId: `pi:${frame.sessionId}:assistant`,
        payload: {
          tokens: { input: body.inputTokens, output: body.outputTokens },
          cost: body.costUsd,
          bridgeSeq: frame.seq,
        },
      };
    case "turn.started":
    case "turn.completed":
      return {
        ...base,
        id: `pi:${frame.sessionId}:${body.kind}`,
        eventType: `pi.${body.kind}`,
        payload: { ...body, bridgeSeq: frame.seq },
      };
  }
}
