"use client";

import { RiAddLine } from "@remixicon/react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Focusable } from "react-aria-components";
import { Button } from "@/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { backendFetch } from "@/lib/backend-fetch";
import { cx } from "@/utils/cx";
import { AvatarMark, StateBadge } from "./avatar-mark";
import { NewBotDialog } from "./new-bot-dialog";
import { absoluteTime, orderRoster, outcomeLine, relativeTime } from "./roster-model";
import type { ApiBot } from "./types";
import { useNow } from "./use-now";

const POLL_MS = 15_000;

function ContactRow({ bot, selected, now }: { bot: ApiBot; selected: boolean; now: number | null }) {
  const nameId = useId();
  const outcomeId = useId();
  const line = outcomeLine(bot, now);
  // When the line had to fall back, the whole reply is one hover away.
  const detail = bot.lastOutcome && bot.lastOutcome !== line ? bot.lastOutcome : null;
  const row = (
    <Link
      href={`/bots/${bot.id}`}
      aria-current={selected ? "page" : undefined}
      aria-labelledby={nameId}
      aria-describedby={outcomeId}
      className={cx(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        selected ? "bg-background-secondary-default" : "hover:bg-background-primary-hover",
      )}
    >
      <AvatarMark tone={bot.avatarTone} icon={bot.avatarIcon} state={bot.state} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-baseline gap-2">
            <span id={nameId} title={bot.name} className="truncate text-body-medium text-text-primary">
              {bot.name}
            </span>
            <StateBadge state={bot.state} />
          </span>
          {bot.lastAt && (
            <time
              dateTime={bot.lastAt}
              title={absoluteTime(bot.lastAt, now) || undefined}
              className="shrink-0 text-caption-1-regular text-text-tertiary"
            >
              {relativeTime(bot.lastAt, now)}
            </time>
          )}
        </span>
        <span
          id={outcomeId}
          className={cx(
            "block truncate text-body-2-regular",
            bot.state === "attention" ? "text-text-primary" : "text-text-secondary",
          )}
        >
          {line}
          {bot.handoffs > 0 && (
            <span className="text-text-tertiary">{` +${bot.handoffs} handoff${bot.handoffs === 1 ? "" : "s"}`}</span>
          )}
        </span>
      </span>
    </Link>
  );
  if (!detail) return row;
  return (
    <TooltipTrigger delay={300}>
      <Focusable>{row}</Focusable>
      <Tooltip size="md" className="max-w-xs">
        <span className="line-clamp-4">{detail}</span>
      </Tooltip>
    </TooltipTrigger>
  );
}

/**
 * Left pane: every bot, needs-you first, one line each - the bot's own words
 * for what it last finished. Polls so a bot that starts working or asks for
 * approval moves up without a reload; the server-rendered list is the first paint.
 * Full width below md (the only pane at /bots); beside the thread above it, a
 * column at the dragged `--roster-w` (the workspace's grip writes it), 320px
 * by default.
 */
export function BotsRoster({
  initialBots,
  selectedId,
  className = "flex",
  style,
  ref,
}: {
  initialBots: ApiBot[];
  selectedId: string | null;
  className?: string;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLElement>;
}) {
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
    <aside
      ref={ref}
      style={style}
      className={cx(
        "w-full shrink-0 flex-col border-r border-border-button-default md:w-[var(--roster-w,20rem)]",
        className,
      )}
    >
      <div className="flex items-center justify-between px-5 pt-5 pb-3">
        <h1 className="text-display-sm text-text-primary">Bots</h1>
        <Button variant="ghost" size="small" iconOnly leadingIcon={RiAddLine} aria-label="New bot" onClick={() => setCreating(true)} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {bots.length === 0 ? (
          <div className="px-3 py-6">
            <Button variant="secondary" size="small" className="rounded-full" onClick={() => setCreating(true)}>
              Create bot
            </Button>
          </div>
        ) : (
          orderRoster(bots).map((bot) => <ContactRow key={bot.id} bot={bot} selected={bot.id === selectedId} now={now} />)
        )}
      </div>
      <NewBotDialog open={creating} onOpenChange={setCreating} />
    </aside>
  );
}
