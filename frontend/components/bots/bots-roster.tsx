"use client";

import { RiAddLine } from "@remixicon/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { backendFetch } from "@/lib/backend-fetch";
import { cx } from "@/utils/cx";
import { AvatarMark } from "./avatar-mark";
import { NewBotDialog } from "./new-bot-dialog";
import { orderRoster, outcomeLine, relativeTime } from "./roster-model";
import type { ApiBot } from "./types";
import { useNow } from "./use-now";

const POLL_MS = 15_000;

function ContactRow({ bot, selected, now }: { bot: ApiBot; selected: boolean; now: number | null }) {
  return (
    <Link
      href={`/bots/${bot.id}`}
      aria-current={selected ? "page" : undefined}
      className={cx(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
        selected ? "bg-background-secondary-default" : "hover:bg-background-primary-hover",
      )}
    >
      <AvatarMark tone={bot.avatarTone} icon={bot.avatarIcon} state={bot.state} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-body-medium text-text-primary">{bot.name}</span>
          <span className="shrink-0 text-caption-1-regular text-text-tertiary">{relativeTime(bot.lastAt, now)}</span>
        </span>
        <span
          className={cx(
            "block truncate text-body-2-regular",
            bot.state === "attention" ? "text-text-primary" : "text-text-secondary",
          )}
        >
          {outcomeLine(bot)}
        </span>
      </span>
    </Link>
  );
}

/**
 * Left pane: every bot, needs-you first, one line each - the bot's own words
 * for what it last finished. Polls so a bot that starts working or asks for
 * approval moves up without a reload; the server-rendered list is the first paint.
 */
export function BotsRoster({ initialBots, selectedId }: { initialBots: ApiBot[]; selectedId: string | null }) {
  const [bots, setBots] = useState(initialBots);
  const [creating, setCreating] = useState(false);
  const now = useNow();

  useEffect(() => {
    setBots(initialBots);
  }, [initialBots]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await backendFetch("/api/bots");
        if (!response.ok) return;
        const data = (await response.json()) as { bots?: ApiBot[] };
        if (!cancelled && Array.isArray(data.bots)) setBots(data.bots);
      } catch {
        // keep the last good roster; the next tick retries
      }
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-border-button-default">
      <div className="flex items-center justify-between px-5 pt-5 pb-3">
        <h1 className="text-headline-medium text-text-primary">Bots</h1>
        <Button variant="ghost" size="small" iconOnly leadingIcon={RiAddLine} aria-label="New bot" onClick={() => setCreating(true)} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {bots.length === 0 ? (
          <p className="px-3 py-6 text-body-2-regular text-text-tertiary">No bots yet.</p>
        ) : (
          orderRoster(bots).map((bot) => <ContactRow key={bot.id} bot={bot} selected={bot.id === selectedId} now={now} />)
        )}
      </div>
      <NewBotDialog open={creating} onOpenChange={setCreating} />
    </aside>
  );
}
