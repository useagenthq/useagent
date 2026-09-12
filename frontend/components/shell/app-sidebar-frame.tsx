"use client";

// The app sidebar frame follows the "Dashboard Inset" sidebar block on
// blocks.so (MIT), on the vendored sidebar primitives in components/sidebar-kit.
// The page is an inset card beside a rail that folds to icons.

import { RiArrowDownSLine, RiArrowUpSLine, RiExpandUpDownLine } from "@remixicon/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";

import { OrbitKnotMark } from "@/components/foundations/brand/orbit-knot-mark";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/sidebar-kit/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/sidebar-kit/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/sidebar-kit/sidebar";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { SearchCommand } from "./search-command";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { useWorkingSignal } from "./working-signal";

export type Route = {
  id: string;
  title: string;
  icon: ReactNode;
  href: string;
  active?: boolean;
  trailing?: ReactNode;
  subs?: { title: string; href: string; icon?: ReactNode }[];
};

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "");
  return letters.join("") || "U";
}

/** Navigation rows: icon rows, with optional collapsible sub-rows. */
export function NavRoutes({ routes }: { routes: Route[] }) {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <SidebarMenu>
      {routes.map((route) => {
        const hasSubs = !!route.subs?.length;
        const isOpen = !isCollapsed && openId === route.id;
        if (hasSubs) {
          return (
            <SidebarMenuItem key={route.id}>
              <Collapsible
                className="w-full"
                onOpenChange={(open) => setOpenId(open ? route.id : null)}
                open={isOpen}
              >
                <CollapsibleTrigger
                  render={
                    <SidebarMenuButton
                      className={cn(
                        "flex w-full items-center rounded-lg px-2 transition-colors",
                        isOpen
                          ? "bg-sidebar-muted text-foreground"
                          : "text-muted-foreground hover:bg-sidebar-muted hover:text-foreground",
                        isCollapsed && "justify-center",
                      )}
                      tooltip={route.title}
                    />
                  }
                >
                  {route.icon}
                  {!isCollapsed && (
                    <span className="ml-2 flex-1 font-medium text-sm">{route.title}</span>
                  )}
                  {!isCollapsed && (
                    <span className="ml-auto">
                      {isOpen ? (
                        <RiArrowUpSLine className="size-4" aria-hidden />
                      ) : (
                        <RiArrowDownSLine className="size-4" aria-hidden />
                      )}
                    </span>
                  )}
                </CollapsibleTrigger>
                {!isCollapsed && (
                  <CollapsibleContent>
                    <SidebarMenuSub className="my-1 ml-3.5">
                      {route.subs?.map((sub) => (
                        <SidebarMenuSubItem className="h-auto" key={`${route.id}-${sub.title}`}>
                          <SidebarMenuSubButton
                            render={
                              <Link
                                className="flex items-center gap-2 rounded-md px-4 py-1.5 font-medium text-muted-foreground text-sm hover:bg-sidebar-muted hover:text-foreground"
                                href={sub.href}
                                prefetch={true}
                              />
                            }
                          >
                            {sub.icon}
                            {sub.title}
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                )}
              </Collapsible>
            </SidebarMenuItem>
          );
        }
        return (
          <SidebarMenuItem key={route.id}>
            <SidebarMenuButton
              isActive={route.active}
              render={
                <Link
                  className={cn(
                    "flex items-center rounded-lg px-2 transition-colors",
                    route.active
                      ? "bg-sidebar-muted text-foreground"
                      : "text-muted-foreground hover:bg-sidebar-muted hover:text-foreground",
                    isCollapsed && "justify-center",
                  )}
                  href={route.href}
                  prefetch={true}
                />
              }
              tooltip={route.title}
            >
              {route.icon}
              {!isCollapsed && <span className="ml-2 font-medium text-sm">{route.title}</span>}
              {!isCollapsed && route.trailing ? (
                <span className="ml-auto">{route.trailing}</span>
              ) : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

/** The footer card is the trigger of the account menu (identity header,
 * Settings, Apps, Log out), so it opens exactly as before. */
export function UserFooter() {
  const { session } = useSession();
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const name = session?.user.name?.trim() || session?.user.email || "Guest";
  const email = session?.user.email ?? "Not signed in";
  const image = session?.user.image ?? null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <UserMenu
          trigger={
            <span
              className={cn(
                "flex w-full items-center gap-2 rounded-lg p-2 text-sm transition-colors hover:bg-sidebar-accent hover:text-foreground",
                isCollapsed && "justify-center p-0",
              )}
            >
              <Avatar className="size-8 rounded-lg">
                {image ? <AvatarImage alt={name} src={image} /> : null}
                <AvatarFallback className="rounded-lg bg-pink-500/20 text-pink-500">
                  {initials(name)}
                </AvatarFallback>
              </Avatar>
              {!isCollapsed && (
                <>
                  <span className="grid min-w-0 flex-1 text-left leading-tight">
                    <span className="truncate font-semibold">{name}</span>
                    <span className="truncate text-muted-foreground text-xs">{email}</span>
                  </span>
                  <RiExpandUpDownLine
                    className="ml-auto size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                </>
              )}
            </span>
          }
        />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/**
 * The frame every app sidebar shares: brand, theme toggle and the collapse
 * trigger in the header, the search row, the account card in the footer. Each
 * sidebar puts its own rows in between.
 */
export function AppSidebarFrame({
  label = "UseAgent",
  children,
}: {
  /** The word beside the brand mark, e.g. "UseAgent" or "Customize". */
  label?: string;
  children: ReactNode;
}) {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const working = useWorkingSignal();

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader
        className={cn(
          "flex md:pt-2",
          isCollapsed
            ? "flex-row items-center justify-between gap-y-4 md:flex-col md:items-start md:justify-start"
            : "flex-row items-center justify-between",
        )}
      >
        <Link
          aria-label="UseAgent new thread"
          className="flex items-center gap-2.5 px-1"
          href="/agent/new"
        >
          <OrbitKnotMark className="size-8" active={working} />
          {!isCollapsed && (
            <span className="text-[19px] font-[650] leading-none tracking-[-0.04em] text-foreground">
              {label}
            </span>
          )}
        </Link>
        <div
          className={cn(
            "flex items-center gap-1",
            isCollapsed ? "flex-row md:flex-col-reverse" : "flex-row",
          )}
        >
          {!isCollapsed && <ThemeToggle />}
          <SidebarTrigger />
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-3 px-1.5 py-3">
        {!isCollapsed && <SearchCommand />}
        {children}
      </SidebarContent>
      <SidebarFooter className="px-2">
        <UserFooter />
      </SidebarFooter>
    </Sidebar>
  );
}
