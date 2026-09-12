"use client";

import { RiArrowUpLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { backendFetch } from "@/lib/backend-fetch";
import { AvatarMark } from "./avatar-mark";
import { type ApiBot, apiErrorText } from "./types";

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
        const data = await response.json().catch(() => ({}));
        return setError(apiErrorText(data, "The bot could not start."));
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
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <AvatarMark tone={bot.avatarTone} icon={bot.avatarIcon} size="size-16" />
        <div className="flex flex-col gap-1">
          <p className="text-title-2-medium text-text-primary">{bot.name}</p>
          <p className="text-body-regular text-text-secondary">{bot.title || "Ready for its first job"}</p>
        </div>
        {error && <p className="text-body-2-regular text-text-error-primary">{error}</p>}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="flex items-center gap-2 border-t border-border-button-default px-5 py-4"
      >
        <Input aria-label={`Message ${bot.name}`} placeholder={`Message ${bot.name}`} value={text} onChange={setText} className="flex-1" />
        <Button variant="primary" size="small" iconOnly leadingIcon={RiArrowUpLine} aria-label="Send" onClick={() => void send()} />
      </form>
    </div>
  );
}
