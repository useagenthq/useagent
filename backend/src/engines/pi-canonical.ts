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

function messageId(frame: Record<string, unknown>, fallback: string): string {
  const message = record(frame.message);
  return text(message?.id) ?? (number(message?.timestamp) !== undefined
    ? `pi-message-${number(message?.timestamp)}`
    : fallback);
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

function assistantContent(
  message: Record<string, unknown>,
  kind: "text" | "thinking",
): string | undefined {
  if (!Array.isArray(message.content)) return undefined;
  const blocks = message.content.flatMap((item) => {
    const block = record(item);
    if (block?.type !== kind) return [];
    const value = kind === "text"
      ? (typeof block.text === "string" ? block.text : undefined)
      : (typeof block.thinking === "string"
        ? block.thinking
        : typeof block.text === "string" ? block.text : undefined);
    return value === undefined ? [] : [value];
  });
  return blocks.length > 0 ? blocks.join("") : undefined;
}

function assistantToolCalls(message: Record<string, unknown>): NativeBridgeFrameBody[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((item) => {
    const block = record(item);
    const toolCallId = text(block?.id);
    const name = text(block?.name);
    return block?.type === "toolCall" && toolCallId && name
      ? [{ kind: "tool.started" as const, toolCallId, name, input: block.arguments }]
      : [];
  });
}

function toolResult(message: Record<string, unknown>): NativeBridgeFrameBody | null {
  if (message.role !== "toolResult") return null;
  const toolCallId = text(message.toolCallId);
  if (!toolCallId) return null;
  const errored = message.isError === true;
  const output = preview(message.content);
  return {
    kind: "tool.completed",
    toolCallId,
    name: text(message.toolName),
    status: errored ? "error" : "ok",
    preview: output,
    ...(errored ? { error: output } : {}),
  };
}

/** Lossless-enough Pi RPC -> provider-neutral bridge mapping. Unknown upstream
 * frames remain available in the native provider lane; they are not fabricated
 * into product events here. */
interface PiFrameState {
  readonly fallbackMessageId: string;
  readonly messageIdsByTimestamp: Map<number, string>;
  activeMessageId: string;
  messageStarted: boolean;
  messageIndex: number;
}

const MAX_TRACKED_MESSAGE_IDS = 2_048;

function resolvedMessageId(
  frame: Record<string, unknown>,
  state: PiFrameState,
): string {
  const timestamp = number(record(frame.message)?.timestamp);
  return timestamp === undefined
    ? messageId(frame, state.activeMessageId)
    : state.messageIdsByTimestamp.get(timestamp) ?? messageId(frame, state.activeMessageId);
}

function rememberMessageId(
  frame: Record<string, unknown>,
  state: PiFrameState,
  id: string,
): void {
  const timestamp = number(record(frame.message)?.timestamp);
  if (timestamp === undefined) return;
  state.messageIdsByTimestamp.delete(timestamp);
  state.messageIdsByTimestamp.set(timestamp, id);
  while (state.messageIdsByTimestamp.size > MAX_TRACKED_MESSAGE_IDS) {
    const oldest = state.messageIdsByTimestamp.keys().next();
    if (oldest.done) break;
    state.messageIdsByTimestamp.delete(oldest.value);
  }
}

function nextFallbackMessageId(state: PiFrameState): string {
  return state.messageIndex === 0
    ? state.fallbackMessageId
    : `${state.fallbackMessageId}-${state.messageIndex}`;
}

function completeMessageFrame(state: PiFrameState, frame: Record<string, unknown>): void {
  if (frame.type !== "message_end" || record(frame.message)?.role !== "assistant") return;
  state.messageIndex += 1;
  state.activeMessageId = nextFallbackMessageId(state);
  state.messageStarted = false;
}

function childOwnedBody(
  childId: string,
  body: NativeBridgeFrameBody,
): NativeBridgeFrameBody | null {
  if (
    body.kind === "turn.started" ||
    body.kind === "commands.updated"
  ) return null;
  return { ...body, ownerChildId: childId };
}

function mapPiRpcFrame(frame: unknown, state: PiFrameState): readonly NativeBridgeFrameBody[] {
  const value = record(frame);
  if (!value) return [];
  switch (value.type) {
    case "agent_start":
      state.messageIndex = 0;
      state.activeMessageId = nextFallbackMessageId(state);
      state.messageStarted = false;
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
    case "message_start": {
      const message = record(value.message);
      if (message?.role !== "assistant") return [];
      const id = resolvedMessageId(value, state);
      state.activeMessageId = id;
      rememberMessageId(value, state, id);
      if (state.messageStarted) return [];
      state.messageStarted = true;
      return [{ kind: "message.started", messageId: id }];
    }
    case "message_update": {
      const update = record(value.assistantMessageEvent);
      const delta = text(update?.delta);
      if (!update || !delta) return [];
      const id = resolvedMessageId(value, state);
      state.activeMessageId = id;
      rememberMessageId(value, state, id);
      const started: NativeBridgeFrameBody[] = state.messageStarted
        ? []
        : [{ kind: "message.started", messageId: id }];
      state.messageStarted = true;
      if (update.type === "text_delta") {
        return [...started, { kind: "message.delta", messageId: id, text: delta }];
      }
      if (update.type === "thinking_delta") {
        return [...started, { kind: "reasoning.delta", messageId: id, text: delta }];
      }
      return [];
    }
    case "message_end": {
      const message = record(value.message);
      const completedTool = message ? toolResult(message) : null;
      if (completedTool) return [completedTool];
      if (message?.role !== "assistant") return [];
      const id = state.messageStarted ? state.activeMessageId : resolvedMessageId(value, state);
      state.activeMessageId = id;
      rememberMessageId(value, state, id);
      const started: NativeBridgeFrameBody[] = state.messageStarted
        ? []
        : [{ kind: "message.started", messageId: id }];
      state.messageStarted = true;
      const finalReasoning = assistantContent(message, "thinking");
      const finalText = assistantContent(message, "text");
      return [
        ...started,
        ...(finalReasoning === undefined
          ? []
          : [{ kind: "reasoning.authoritative", messageId: id, text: finalReasoning } as const]),
        ...(finalText === undefined
          ? []
          : [{ kind: "message.authoritative", messageId: id, text: finalText } as const]),
        ...assistantToolCalls(message),
        usageFrame(message),
        assistantFailure(message),
        { kind: "message.completed", messageId: id },
      ].filter(Boolean) as NativeBridgeFrameBody[];
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

export function createPiRpcFrameMapper(fallbackMessageId: string) {
  const state: PiFrameState = {
    fallbackMessageId,
    messageIdsByTimestamp: new Map(),
    activeMessageId: fallbackMessageId,
    messageStarted: false,
    messageIndex: 0,
  };
  const childStates = new Map<string, PiFrameState>();
  return (frame: unknown): readonly NativeBridgeFrameBody[] => {
    const value = record(frame);
    if (value?.type === "subagent_event") {
      const payload = record(value.payload);
      const childId = text(payload?.id);
      const childFrame = record(payload?.event);
      if (!childId || !childFrame) return [];
      const childState = childStates.get(childId) ?? {
        fallbackMessageId: `${fallbackMessageId}-child-${childId}`,
        messageIdsByTimestamp: new Map(),
        activeMessageId: `${fallbackMessageId}-child-${childId}`,
        messageStarted: false,
        messageIndex: 0,
      };
      childStates.set(childId, childState);
      const bodies = mapPiRpcFrame(childFrame, childState).flatMap((body) => {
        const owned = childOwnedBody(childId, body);
        return owned ? [owned] : [];
      });
      completeMessageFrame(childState, childFrame);
      return bodies;
    }
    const bodies = mapPiRpcFrame(frame, state);
    if (value) completeMessageFrame(state, value);
    return bodies;
  };
}

export function piRpcFrameBodies(frame: unknown): readonly NativeBridgeFrameBody[] {
  return createPiRpcFrameMapper("pi-message-standalone")(frame);
}
