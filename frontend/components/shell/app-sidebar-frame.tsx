"use client";

// The app sidebar frame follows the "Dashboard Inset" sidebar block on
// blocks.so (MIT), on the vendored sidebar primitives in components/sidebar-kit.
// The page is an inset card beside a rail that folds to icons. The rows inside
// the frame are this product's own nav rows and tokens.

import {
  type RemixiconComponentType,
  RiArrowDownSLine,
  RiExpandUpDownLine,
} from "@remixicon/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";

import { OrbitKnotMark } from "@/components/foundations/brand/orbit-knot-mark";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/sidebar-kit/avatar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/sidebar-kit/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/sidebar-kit/sidebar";
import { useSession } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { SearchCommand } from "./search-command";
import { NAV_ICON_TONE, type NavIconTone, SidebarNavItem } from "./sidebar-nav";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { useWorkingSignal } from "./working-signal";

export type Route = {
  id: string;
  title: string;
  icon: RemixiconComponentType;
  href: string;
  active?: boolean;
  /** Brand tint for the icon, as on the previous rail. */
  tone?: NavIconTone;
  trailing?: ReactNode;
  /** A group: expanded, the row opens these rows underneath instead of navigating. */
  subs?: { title: string; href: string; icon: RemixiconComponentType; active?: boolean }[];
};

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "");
  return letters.join("") || "U";
}

/** A group row in the nav-row recipe: same padding, tone and type as a
 * SidebarNavItem, with a chevron, opening its rows underneath. */
function NavGroup({ route }: { route: Route }) {
  const Icon = route.icon;
  const [open, setOpen] = useState(route.subs?.some((sub) => sub.active) ?? false);
  return (
    <Collapsible className="w-full" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2.5 rounded-2lg px-2.5 py-2 text-body-2-medium transition-colors",
          "text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary",
        )}
      >
        <span className="flex w-4 shrink-0 items-center justify-center">
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              route.tone ? NAV_ICON_TONE[route.tone] : "text-foreground-icon-tertiary",
            )}
            aria-hidden
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{route.title}</span>
        <RiArrowDownSLine
          className={cn(
            "size-4 shrink-0 text-foreground-icon-tertiary transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col pl-6">
          {route.subs?.map((sub) => (
            <SidebarNavItem
              key={sub.title}
              href={sub.href}
              icon={sub.icon}
              label={sub.title}
              active={sub.active}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The rail's nav rows: the product's SidebarNavItem when expanded, tinted
 * icon buttons with tooltips when folded. */
export function NavRoutes({ routes }: { routes: Route[] }) {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  return (
    <SidebarMenu className={cn("gap-0", isCollapsed && "items-center gap-1")}>
      {routes.map((route) => {
        const Icon = route.icon;
        return (
          <SidebarMenuItem key={route.id} className={cn(isCollapsed && "w-8")}>
            {!isCollapsed && route.subs?.length ? (
              <NavGroup route={route} />
            ) : isCollapsed ? (
              <SidebarMenuButton
                className={cn(
                  "justify-center rounded-2lg",
                  route.active
                    ? "bg-linear-to-b from-accent-500 to-accent-600 text-white shadow-nav-selected hover:text-white"
                    : "text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary",
                )}
                isActive={route.active}
                render={<Link href={route.href} aria-current={route.active ? "page" : undefined} />}
                tooltip={route.title}
              >
                <Icon
                  className={cn(
                    "size-4",
                    route.active
                      ? "text-white"
                      : route.tone
                        ? NAV_ICON_TONE[route.tone]
                        : "text-foreground-icon-tertiary",
                  )}
                  aria-hidden
                />
              </SidebarMenuButton>
            ) : (
              <SidebarNavItem
                href={route.href}
                icon={Icon}
                tone={route.tone}
                label={route.title}
                active={route.active}
                trailing={route.trailing}
              />
            )}
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
                "flex w-full items-center gap-2.5 rounded-2lg px-2.5 py-2 transition-colors hover:bg-background-secondary-hover",
                isCollapsed && "justify-center px-0",
              )}
            >
              <Avatar className="size-8 rounded-full">
                {image ? <AvatarImage alt={name} src={image} /> : null}
                <AvatarFallback className="rounded-full bg-pink-500/20 text-pink-500 text-caption-1-medium">
                  {initials(name)}
                </AvatarFallback>
              </Avatar>
              {!isCollapsed && (
                <>
                  <span className="grid min-w-0 flex-1 text-left leading-tight">
                    <span className="truncate text-body-2-medium text-text-primary">{name}</span>
                    <span className="truncate text-caption-1-regular text-text-secondary">
                      {email}
                    </span>
                  </span>
                  <RiExpandUpDownLine
                    className="ml-auto size-4 shrink-0 text-foreground-icon-tertiary"
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
            ? "flex-row items-center justify-between gap-y-3 px-0 md:flex-col md:items-center md:justify-start"
            : "flex-row items-center justify-between px-2",
        )}
      >
        <Link
          aria-label="UseAgent new thread"
          className={cn(
            "flex items-center gap-2.5 rounded-2lg py-1.5 text-text-primary outline-none transition-colors hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring",
            isCollapsed ? "justify-center px-0" : "px-2",
          )}
          href="/agent/new"
        >
          <OrbitKnotMark className="size-8" active={working} />
          {!isCollapsed && <span className="truncate text-body-2-medium">{label}</span>}
        </Link>
        <div
          className={cn(
            "flex items-center gap-1",
            isCollapsed ? "flex-row md:flex-col-reverse" : "flex-row",
          )}
        >
          {!isCollapsed && <ThemeToggle />}
          <SidebarTrigger className="rounded-2lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary" />
        </div>
      </SidebarHeader>
      <SidebarContent
        className={cn("gap-1 pt-0.5 pb-3", isCollapsed ? "items-center px-0" : "px-2")}
      >
        {!isCollapsed && <SearchCommand />}
        {children}
      </SidebarContent>
      <SidebarFooter className={cn("pb-2", isCollapsed ? "items-center px-0" : "px-2")}>
        <UserFooter />
      </SidebarFooter>
    </Sidebar>
  );
}
