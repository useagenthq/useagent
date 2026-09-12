import type { RunResourceSelection } from "@useagent/agent-client/wire";
import type { EngineId, MemoryScope } from "@/components/chat/types";

export type ReplyCommand = { name: string; args: string };

/**
 * The `POST /api/runs` body for a reply in an existing thread. Optional parts
 * are only present when set, so the wire shape stays exactly what the backend
 * validates today: attachments, resources and bot mentions appear only when
 * non-empty, and a catalog command carries the provider session and catalog
 * revision it was composed against so stale intent fails closed.
 */
export function replyRunBody(input: {
  readonly text: string;
  readonly engine: EngineId;
  /** Null when the engine has no negotiated model selection (no override is sent). */
  readonly model: string | null;
  readonly parentRunId: string;
  readonly memoryScope: MemoryScope;
  readonly attachmentIds: readonly string[];
  readonly resources: readonly RunResourceSelection[];
  readonly botMentions: readonly string[];
  readonly command?: ReplyCommand | null;
  readonly engineSessionId: string | null | undefined;
  readonly commandCatalogRevision: number | null | undefined;
}): Record<string, unknown> {
  return {
    prompt: input.text,
    engine: input.engine,
    ...(input.model !== null ? { model: input.model } : {}),
    parent_run_id: input.parentRunId,
    memory_scope: input.memoryScope,
    ...(input.attachmentIds.length > 0 ? { attachments: input.attachmentIds } : {}),
    ...(input.resources.length > 0 ? { resources: input.resources } : {}),
    ...(input.botMentions.length > 0 ? { bot_mentions: input.botMentions } : {}),
    ...(input.command
      ? {
          command: {
            ...input.command,
            provider: input.engine,
            sessionId: input.engineSessionId ?? undefined,
            catalogRevision: input.commandCatalogRevision ?? undefined,
          },
        }
      : {}),
  };
}
