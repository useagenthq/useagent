"use client";

import { RiArrowUpLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import { AvatarOrb } from "./avatar-orb";
import { engineLabel, type ApiBot } from "./types";

/**
 * A bot with no home thread yet. The first message creates the root run with
 * the bot's preset and standing rules; after that the page renders the real
 * thread and its composer takes over.
 */
export function FirstMessage({ bot }: { bot: ApiBot }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await backendFetch(`/api/bots/${bot.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ text: trimmed }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string; reason?: string };
        setError(data.reason ?? data.error ?? "The bot could not start.");
        return;
      }
      setText("");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <AvatarOrb tone={bot.avatarTone} icon={bot.avatarIcon} size="size-14" />
        <div>
          <p className="text-headline-medium text-text-primary">{bot.name}</p>
          <p className="text-body-2-regular text-text-secondary">
            {bot.title || "Ready for a standing job"} · {engineLabel(bot.engine)}
          </p>
        </div>
        <p className="max-w-md text-body-2-regular text-text-tertiary">
          Give {bot.name} its first task. That message opens its home thread with the standing rules in force; every later message continues the same conversation.
        </p>
        {error && <p className="text-caption-1-regular text-text-error-primary">{error}</p>}
      </div>
      <div className="border-t border-border-button-default p-4">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          className="flex items-center gap-2 rounded-2xl border border-border-button-default bg-background-primary-default p-2 pl-3 focus-within:border-border-button-hover"
        >
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={`Message ${bot.name}`}
            className="min-w-0 flex-1 bg-transparent text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder"
          />
          <button
            type="submit"
            aria-label="Send"
            className="flex size-8 items-center justify-center rounded-xl bg-button-primary text-text-white disabled:opacity-60"
            disabled={busy || !text.trim()}
          >
            <RiArrowUpLine className="size-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
