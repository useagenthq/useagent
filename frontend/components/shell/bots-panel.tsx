"use client";

import { RiAddLine } from "@remixicon/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/base/buttons/button";
import { AvatarMark, StateBadge } from "@/components/bots/avatar-mark";
import { loadBots } from "@/components/bots/load";
import { NewBotDialog } from "@/components/bots/new-bot-dialog";
import { orderRoster, outcomeLine } from "@/components/bots/roster-model";
import { type ApiBot, engineLabel } from "@/components/bots/types";
import { useNow } from "@/components/bots/use-now";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/sidebar-kit/sidebar";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { cn } from "@/lib/utils";

/**
 * The bots roster as the shell's second column. The navigation rail stays on
 * the left; this panel lists every bot with its face, one-line outcome and
 * state, and the page to the right is the selected bot's thread. Pattern after
 * the double-sided sidebar block on blocks.so (MIT).
 */
export function BotsPanel({
  initialBots,
  initialError = false,
}: {
  initialBots: ApiBot[] | null;
  initialError?: boolean;
}) {
  const pathname = usePathname();
  const firstPathname = useRef(pathname);
  const [bots, setBots] = useState<ApiBot[] | null>(() =>
    initialBots ? orderRoster(initialBots) : null,
  );
  const [error, setError] = useState(initialError);
  const [creating, setCreating] = useState(false);
  const now = useNow();

  const refresh = useCallback(async () => {
    try {
      const list = await loadBots();
      if (list === null) {
        setError(true);
        return;
      }
      setBots(orderRoster(list));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useOrgChanges((change) => {
    if (change.type === "run") void refresh();
  });

  useEffect(() => {
    // A failed server refresh must not discard the last successful roster.
    if (!initialError || initialBots !== null) {
      setBots(initialBots ? orderRoster(initialBots) : null);
    }
    setError(initialError);
  }, [initialBots, initialError]);

  useEffect(() => {
    if (pathname === firstPathname.current) return;
    firstPathname.current = pathname;
    void refresh();
  }, [pathname, refresh]);

  const attention = bots?.filter((bot) => bot.state === "attention").length ?? 0;

  return (
    <Sidebar
      className="hidden w-80 border-r border-sidebar-border md:flex"
      collapsible="none"
      side="left"
      variant="sidebar"
    >
      <SidebarHeader className="flex flex-row items-center justify-between border-b border-sidebar-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h3 className="font-medium text-foreground">Bots</h3>
          <span className="text-muted-foreground text-xs">
            {bots?.length ?? 0}
            {attention > 0 ? ` · ${attention} need you` : ""}
          </span>
        </div>
        <Button
          aria-label="New bot"
          iconOnly
          leadingIcon={RiAddLine}
          onClick={() => setCreating(true)}
          size="small"
          variant="ghost"
        />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {error && (
                <li className="flex flex-col items-start gap-2 px-3 py-3" role="alert">
                  <span className="text-muted-foreground text-xs">
                    {bots ? "Couldn't refresh bots." : "Couldn't load bots."}
                  </span>
                  <Button
                    className="rounded-full"
                    onClick={() => void refresh()}
                    size="xs"
                    variant="secondary"
                  >
                    Try again
                  </Button>
                </li>
              )}
              {bots?.map((bot) => {
                const href = `/bots/${bot.id}`;
                const selected = pathname === href;
                return (
                  <SidebarMenuItem key={bot.id}>
                    <SidebarMenuButton
                      className={cn(
                        "h-auto w-full justify-start gap-3 px-3 py-2",
                        selected
                          ? "bg-sidebar-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      isActive={selected}
                      render={<Link href={href} />}
                    >
                      <AvatarMark
                        tone={bot.avatarTone}
                        icon={bot.avatarIcon}
                        state={bot.state}
                        size="size-9"
                        className="mt-0.5 shrink-0 self-start"
                      />
                      <div className="min-w-0 flex-1 text-left">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-foreground">{bot.name}</span>
                          <StateBadge state={bot.state} />
                        </div>
                        <div className="mt-0.5 truncate text-muted-foreground text-xs">
                          {outcomeLine(bot, now)}
                        </div>
                        <div className="mt-0.5 truncate text-muted-foreground text-[11px]">
                          {engineLabel(bot.engine)}
                          {bot.routines > 0
                            ? ` · ${bot.routines} routine${bot.routines === 1 ? "" : "s"}`
                            : ""}
                        </div>
                      </div>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
              {bots === null && !error && (
                <li className="px-3 py-6 text-center text-muted-foreground text-sm">
                  Loading bots
                </li>
              )}
              {bots?.length === 0 && !error && (
                <li className="px-3 py-6 text-center text-muted-foreground text-sm">No bots yet</li>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <NewBotDialog open={creating} onOpenChange={setCreating} />
    </Sidebar>
  );
}
