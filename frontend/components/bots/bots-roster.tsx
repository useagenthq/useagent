"use client";

import { RiAddLine, RiRobot2Line } from "@remixicon/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { backendFetch } from "@/lib/backend-fetch";
import { cx } from "@/utils/cx";
import { AvatarOrb } from "./avatar-orb";
import { NewBotDialog } from "./new-bot-dialog";
import { groupRoster, outcomeLine, relativeTime } from "./roster-model";
import type { ApiBot } from "./types";

const POLL_MS = 15_000;

function ContactRow({ bot, selected }: { bot: ApiBot; selected: boolean }) {
  return (
    <Link
      href={`/bots/${bot.id}`}
      aria-current={selected ? "page" : undefined}
      className={cx(
        "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors",
        selected ? "bg-background-secondary-default" : "hover:bg-background-primary-hover",
      )}
    >
      <AvatarOrb tone={bot.avatarTone} icon={bot.avatarIcon} state={bot.state} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-body-2-medium text-text-primary">{bot.name}</span>
          <span className="shrink-0 text-caption-1-regular text-text-tertiary">{relativeTime(bot.lastAt)}</span>
        </span>
        <span
          className={cx(
            "block truncate text-caption-1-regular text-text-secondary",
            bot.state === "working" && "agent-progress-loading-text",
          )}
        >
          {outcomeLine(bot)}
        </span>
      </span>
      {bot.state === "attention" && <span className="size-2 shrink-0 rounded-full bg-yellow-500" aria-hidden />}
    </Link>
  );
}

/**
 * Left pane: every bot in the org grouped by derived state. Polls the API so
 * a bot that starts working or asks for approval moves sections without a
 * reload; the server-rendered list is the first paint.
 */
export function BotsRoster({ initialBots, selectedId }: { initialBots: ApiBot[]; selectedId: string | null }) {
  const [bots, setBots] = useState(initialBots);
  const [creating, setCreating] = useState(false);

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

  const sections = groupRoster(bots);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-border-button-default">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <RiRobot2Line className="size-4 text-text-tertiary" aria-hidden />
          <h1 className="text-headline-medium text-text-primary">Bots</h1>
        </div>
        <Button variant="secondary" size="small" leadingIcon={RiAddLine} onClick={() => setCreating(true)}>
          New bot
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-1">
        {sections.length === 0 ? (
          <p className="px-2.5 py-6 text-body-2-regular text-text-tertiary">
            No bots yet. Create one and give it a standing job.
          </p>
        ) : (
          sections.map((section) => (
            <div key={section.state} className="flex flex-col gap-0.5 pb-1.5">
              <p className="text-mono-label px-2.5 pt-2 pb-1 text-text-tertiary">{section.label}</p>
              {section.bots.map((bot) => (
                <ContactRow key={bot.id} bot={bot} selected={bot.id === selectedId} />
              ))}
            </div>
          ))
        )}
      </div>
      <NewBotDialog open={creating} onOpenChange={setCreating} />
    </aside>
  );
}
