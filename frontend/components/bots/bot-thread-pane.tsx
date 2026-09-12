"use client";

import { useCallback, useState } from "react";
import type { ThreadView } from "@/components/chat/load-thread-view";
import { SessionView } from "@/components/chat/session-view";
import type { ApiRun } from "@/components/chat/types";
import { BotThreadHeader } from "./bot-details";
import { botAssistantIdentity, botReadOnlyMessage } from "./identity";
import type { ApiBot } from "./types";

/**
 * The bot's header over its home thread. The model is per turn (the composer's
 * picker is live), so the header follows the newest turn the thread STREAM
 * sees, not the server-rendered thread: a model picked for the latest turn
 * shows without a reload.
 */
export function BotThreadPane({ bot, thread }: { bot: ApiBot; thread: ThreadView }) {
  const [threadModel, setThreadModel] = useState<string | null>(thread.thread.at(-1)?.model ?? null);
  const onNewestTurnChange = useCallback((run: ApiRun) => setThreadModel(run.model), []);
  return (
    <>
      <BotThreadHeader bot={bot} threadModel={threadModel} />
      <SessionView
        initialThread={thread.thread}
        initialOutline={thread.outline}
        initialRelationshipHint={thread.relationshipHint}
        assistantIdentity={botAssistantIdentity(bot)}
        readOnlyMessage={botReadOnlyMessage(bot) ?? undefined}
        onNewestTurnChange={onNewestTurnChange}
      />
    </>
  );
}
