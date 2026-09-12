"use client";

import { RiAddLine } from "@remixicon/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { AvatarMark, StateBadge } from "@/components/bots/avatar-mark";
import { loadBots } from "@/components/bots/load";
import { orderRoster, outcomeLine } from "@/components/bots/roster-model";
import { type ApiBot, engineLabel } from "@/components/bots/types";
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

const POLL_MS = 30_000;

/**
 * The bots roster as the shell's second column. The navigation rail stays on
 * the left; this panel lists every bot with its face, one-line outcome and
 * state, and the page to the right is the selected bot's thread. Pattern after
 * the double-sided sidebar block on blocks.so (MIT).
 */
export function BotsPanel() {
  const pathname = usePathname();
  const [bots, setBots] = useState<ApiBot[]>([]);
  const [now, setNow] = useState<number | null>(null);

  const refresh = async () => {
    try {
      const list = await loadBots();
      if (list) setBots(orderRoster(list));
    } catch {
      /* the panel is ambient; the page reports errors */
    }
  };

  useOrgChanges((change) => {
    if (change.type === "run") void refresh();
  });

  useEffect(() => {
    setNow(Date.now());
    void refresh();
    const id = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const attention = bots.filter((bot) => bot.state === "attention").length;

  return (
    <Sidebar
      className="w-80 border-r border-sidebar-border"
      collapsible="none"
      side="left"
      variant="sidebar"
    >
      <SidebarHeader className="flex flex-row items-center justify-between border-b border-sidebar-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h3 className="font-medium text-foreground">Bots</h3>
          <span className="text-muted-foreground text-xs">
            {bots.length}
            {attention > 0 ? ` · ${attention} need you` : ""}
          </span>
        </div>
        <Link
          aria-label="New bot"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          href="/bots?new=1"
        >
          <RiAddLine className="size-4" aria-hidden />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {bots.map((bot) => {
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
              {bots.length === 0 && (
                <li className="px-3 py-6 text-center text-muted-foreground text-sm">No bots yet</li>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
