"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ReplyComposer } from "@/components/chat/reply-composer";
import type { EngineId } from "@/components/chat/types";
import { backendFetch } from "@/lib/backend-fetch";
import { AvatarMark } from "./avatar-mark";
import { type ApiBot, apiErrorText, OFFLINE_MESSAGE } from "./types";

/**
 * A bot with no home thread yet. The first message creates the root run with
 * the bot's preset and standing rules; after that the page renders the real
 * thread. Same composer as every later turn, so the first message feels like
 * the second.
 */
export function FirstMessage({ bot }: { bot: ApiBot }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const send = async (text: string, idempotencyKey: string) => {
    setBusy(true);
    try {
      const response = await backendFetch(`/api/bots/${bot.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ text }),
      }).catch(() => {
        throw new Error(OFFLINE_MESSAGE);
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        // Lost a race with another first message: the thread exists now. Show it.
        if (response.status === 409 && data.error === "home_thread_already_created") return router.refresh();
        // The composer keeps the draft and shows this next to its retry.
        throw new Error(apiErrorText(data, "Unable to start the bot. Try again."));
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <AvatarMark tone={bot.avatarTone} icon={bot.avatarIcon} size="size-16" />
        <div className="flex flex-col gap-1">
          <h2 className="text-display-sm text-text-primary">{bot.name}</h2>
          <p className="text-body-regular text-text-secondary">{bot.title || "Ready for its first job"}</p>
        </div>
      </div>
      <ReplyComposer
        engine={bot.engine as EngineId}
        model={bot.model ?? ""}
        memoryScope={bot.memoryScope}
        pending={busy}
        placeholder={`Message ${bot.name}`}
        onReply={(text, _engine, _model, idempotencyKey) => send(text, idempotencyKey)}
      />
    </div>
  );
}
