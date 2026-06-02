import {
  bridgeChildUsage,
  type NativeBridgeFrameBody,
} from "@useagent/agent-harness/bridge";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function preview(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw && raw !== "{}" ? raw.slice(0, 4_000) : undefined;
}

function messageId(frame: Record<string, unknown>): string {
  const message = record(frame.message);
  return text(message?.id) ?? `pi-message-${number(message?.timestamp) ?? Date.now()}`;
}

function usageFrame(message: Record<string, unknown> | null): NativeBridgeFrameBody | null {
  const usage = record(message?.usage);
  if (!usage) return null;
  return {
    kind: "usage.updated",
    inputTokens: number(usage.input) ?? number(usage.inputTokens),
    outputTokens: number(usage.output) ?? number(usage.outputTokens),
    costUsd: number(usage.cost) ?? number(usage.totalCost),
  };
}

function assistantFailure(message: Record<string, unknown> | null): NativeBridgeFrameBody | null {
  if (message?.role !== "assistant") return null;
  const stopReason = text(message.stopReason);
  const error = text(message.errorMessage) ?? text(message.errorClassificationMessage);
  if (stopReason !== "error" && stopReason !== "aborted" && !error) return null;
  return {
    kind: "turn.failed",
    error: error ?? `Pi turn ${stopReason}`,
    ...(stopReason ? { stopReason } : {}),
  };
}

/** Lossless-enough Pi RPC -> provider-neutral bridge mapping. Unknown upstream
 * frames remain available in the native provider lane; they are not fabricated
 * into product events here. */
export function piRpcFrameBodies(frame: unknown): readonly NativeBridgeFrameBody[] {
  const value = record(frame);
  if (!value) return [];
  switch (value.type) {
    case "agent_start":
      return [{ kind: "turn.started" }];
    case "agent_end": {
      if (value.isTerminal === false) return [];
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const failure = messages
        .map(record)
        .filter((message): message is Record<string, unknown> => message !== null)
        .map(assistantFailure)
        .find((item): item is NativeBridgeFrameBody => item !== null);
      return [failure ?? { kind: "turn.completed" }];
    }
    case "prompt_result":
      return value.agentInvoked === false ? [{ kind: "turn.completed", stopReason: "command" }] : [];
    case "message_update": {
      const update = record(value.assistantMessageEvent);
      const delta = text(update?.delta);
      if (!update || !delta) return [];
      if (update.type === "text_delta") {
        return [{ kind: "message.delta", messageId: messageId(value), text: delta }];
      }
      if (update.type === "thinking_delta") {
        return [{ kind: "reasoning.delta", messageId: messageId(value), text: delta }];
      }
      return [];
    }
    case "message_end": {
      const message = record(value.message);
      if (message?.role !== "assistant") return [];
      return [usageFrame(message), assistantFailure(message)].filter(Boolean) as NativeBridgeFrameBody[];
    }
    case "rpc_frame_error":
      return [{ kind: "turn.failed", error: text(value.error) ?? "Pi RPC frame failed" }];
    case "tool_execution_start":
      return [{
        kind: "tool.started",
        toolCallId: text(value.toolCallId) ?? "pi-tool",
        name: text(value.toolName) ?? "tool",
        input: value.args,
      }];
    case "tool_execution_update":
      return [{
        kind: "tool.progress",
        toolCallId: text(value.toolCallId) ?? "pi-tool",
        name: text(value.toolName),
        preview: preview(value.partialResult),
      }];
    case "tool_execution_end":
      return [{
        kind: "tool.completed",
        toolCallId: text(value.toolCallId) ?? "pi-tool",
        name: text(value.toolName),
        status: value.isError === true ? "error" : "ok",
        preview: preview(value.result),
        ...(value.isError === true ? { error: preview(value.result) } : {}),
      }];
    case "todo_reminder": {
      const todos = Array.isArray(value.todos) ? value.todos : [];
      return [{
        kind: "plan.updated",
        entries: todos.flatMap((item, index) => {
          const todo = record(item);
          const label = text(todo?.text) ?? text(todo?.content) ?? text(todo?.title);
          if (!label) return [];
          const rawStatus = text(todo?.status);
          const status = rawStatus === "completed" || rawStatus === "cancelled" || rawStatus === "in_progress"
            ? rawStatus
            : "pending";
          return [{ id: text(todo?.id) ?? `todo-${index}`, text: label, status }];
        }),
      }];
    }
    case "available_commands_update": {
      const commands = Array.isArray(value.commands) ? value.commands : [];
      return [{
        kind: "commands.updated",
        commands: commands.flatMap((item) => {
          const command = record(item);
          const name = text(command?.name);
          if (!name) return [];
          const input = record(command?.input);
          return [{
            name,
            ...(text(command?.description) ? { description: text(command?.description) } : {}),
            ...(text(input?.hint) ? { input: text(input?.hint) } : {}),
          }];
        }),
      }];
    }
    case "subagent_lifecycle": {
      const payload = record(value.payload);
      const childId = text(payload?.id);
      const status = text(payload?.status);
      if (!payload || !childId || !status) return [];
      const state = {
        status,
        prompt: text(payload.description),
        role: text(payload.agent),
        resumable: text(payload.sessionFile) !== undefined,
      };
      if (status === "started") {
        return [{
          kind: "child.started",
          childId,
          title: text(payload.description) ?? text(payload.agent),
          launchToolCallId: text(payload.parentToolCallId),
          state,
        }];
      }
      return [{
        kind: "child.completed",
        childId,
        status: status === "completed" ? "ok" : "error",
        state,
      }];
    }
    case "subagent_progress": {
      const payload = record(value.payload);
      const progress = record(payload?.progress);
      const childId = text(progress?.id) ?? text(payload?.id);
      if (!progress || !childId) return [];
      return [{
        kind: "child.updated",
        childId,
        status: text(progress.status) ?? "running",
        state: {
          status: text(progress.status),
          prompt: text(progress.task) ?? text(payload?.task),
          summary: Array.isArray(progress.recentOutput)
            ? progress.recentOutput.filter((item): item is string => typeof item === "string").slice(-3).join("\n")
            : undefined,
          lastToolName: text(progress.currentTool),
          usage: bridgeChildUsage({
            tokens: progress.tokens,
            costUsd: progress.cost,
            durationMs: progress.durationMs,
          }),
          model: text(progress.resolvedModel),
          role: text(progress.agent),
          resumable: text(payload?.sessionFile) !== undefined,
        },
      }];
    }
    default:
      return [];
  }
}
