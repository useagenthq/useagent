"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadView } from "@/components/chat/load-thread-view";
import { SessionView } from "@/components/chat/session-view";
import type { ApiRun } from "@/components/chat/types";
import { backendFetch } from "@/lib/backend-fetch";
import { BotThreadHeader } from "./bot-details";
import { botAssistantIdentity, botReadOnlyMessage } from "./identity";
import type { ApiBot } from "./types";

const BOT_REFRESH_MS = 15_000;

/** Fetch the backend's whole-bot projection. Never derive header state from
 *  only the home thread: delegated work and approvals contribute too. */
export async function fetchLiveBot(
  botId: string,
  request: (path: string) => Promise<Response> = backendFetch,
): Promise<ApiBot | null> {
  const response = await request(`/api/bots/${botId}`);
  if (!response.ok) return null;
  const body = (await response.json()) as { bot?: ApiBot };
  return body.bot?.id === botId ? body.bot : null;
}

/**
 * The bot's header over its home thread. The model is per turn (the composer's
 * picker is live), so the header follows the newest turn the thread STREAM
 * sees, not the server-rendered thread: a model picked for the latest turn
 * shows without a reload.
 */
export function BotThreadPane({ bot, thread }: { bot: ApiBot; thread: ThreadView }) {
  const [liveBot, setLiveBot] = useState(bot);
  const [threadModel, setThreadModel] = useState<string | null>(thread.thread.at(-1)?.model ?? null);
  const refreshVersion = useRef(0);
  const newestKey = useRef("");
  const refreshBot = useCallback(async () => {
    const version = ++refreshVersion.current;
    const next = await fetchLiveBot(bot.id).catch(() => null);
    if (next && version === refreshVersion.current) setLiveBot(next);
  }, [bot.id]);
  const onNewestTurnChange = useCallback((run: ApiRun) => {
    setThreadModel(run.model);
    const key = `${run.id}:${run.status}:${run.updated_at}`;
    if (newestKey.current === key) return;
    newestKey.current = key;
    void refreshBot();
  }, [refreshBot]);

  useEffect(() => {
    setLiveBot(bot);
    newestKey.current = "";
    refreshVersion.current += 1;
    void refreshBot();
  }, [bot, refreshBot]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshBot(), BOT_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      refreshVersion.current += 1;
    };
  }, [refreshBot]);

  return (
    <>
      <BotThreadHeader bot={liveBot} threadModel={threadModel} />
      <SessionView
        initialThread={thread.thread}
        initialOutline={thread.outline}
        initialRelationshipHint={thread.relationshipHint}
        assistantIdentity={botAssistantIdentity(liveBot)}
        readOnlyMessage={botReadOnlyMessage(liveBot) ?? undefined}
        onNewestTurnChange={onNewestTurnChange}
      />
    </>
  );
}
