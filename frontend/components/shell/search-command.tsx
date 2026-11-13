"use client";

import {
  RiAddLine,
  RiApps2Line,
  RiAppsLine,
  RiBook2Line,
  RiBookMarkedLine,
  RiBrainLine,
  RiCalendarScheduleLine,
  RiChat3Line,
  RiCornerDownLeftLine,
  RiDashboardLine,
  RiDatabase2Line,
  RiFileTextLine,
  RiFlashlightLine,
  RiFlaskLine,
  RiGitPullRequestLine,
  RiKey2Line,
  RiPlugLine,
  RiPulseLine,
  RiSearch2Line,
  RiSettings3Line,
} from "@remixicon/react";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import type { ComponentType } from "react";
import * as React from "react";

import { Kbd } from "@/components/base/kbd/kbd";
import { runTitle } from "@/components/chat/types";
import * as CommandMenu from "@/components/session-ui/command-palette";
import { StatusDot } from "@/components/shared/status-dot";
import { useLabAccess } from "@/lib/lab-access";
import { cx } from "@/utils/cx";
import { relativeTimeShort } from "@/utils/format";
import { messageMatchHref, useMessageSearch, visibleMessageMatches } from "./message-search";
import { runPrimaryRepo } from "./sidebar-project-groups";
import { useSidebarThreadRelationships, useSidebarThreads } from "./sidebar-threads-provider";
import {
  effectiveThreadStatus,
  filterCommandEntries,
  findChildThreadMatches,
  findThreadMatches,
  threadActivityTimestamp,
  threadStatusPresentation,
} from "./thread-discovery";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

type Cmd = {
  href: string;
  label: string;
  icon: IconComponent;
  group: "Threads" | "Customize" | "Developer";
};

// Every supported useAgent route surfaced by the ⌘K palette.
const COMMANDS: Cmd[] = [
  { href: "/agent/new", label: "New thread", icon: RiAddLine, group: "Threads" },
  { href: "/agent/runs", label: "All threads", icon: RiPulseLine, group: "Threads" },

  { href: "/skills", label: "Skills", icon: RiFlashlightLine, group: "Customize" },
  { href: "/playbooks", label: "Playbooks", icon: RiBookMarkedLine, group: "Customize" },
  {
    href: "/agent/automations",
    label: "Automations",
    icon: RiCalendarScheduleLine,
    group: "Customize",
  },
  { href: "/knowledge", label: "Knowledge", icon: RiBrainLine, group: "Customize" },
  { href: "/memory", label: "Memory", icon: RiDatabase2Line, group: "Customize" },
  { href: "/wiki", label: "Wiki", icon: RiBook2Line, group: "Customize" },
  { href: "/apps", label: "Apps", icon: RiAppsLine, group: "Customize" },
  { href: "/agent/artifacts", label: "Artifacts", icon: RiApps2Line, group: "Customize" },
  { href: "/agent/plugins", label: "Plugins", icon: RiPlugLine, group: "Customize" },
  { href: "/secrets", label: "Secrets", icon: RiKey2Line, group: "Customize" },
  { href: "/settings", label: "Settings", icon: RiSettings3Line, group: "Customize" },

  { href: "/dashboard", label: "Dashboard", icon: RiDashboardLine, group: "Developer" },
  { href: "/review", label: "Review", icon: RiGitPullRequestLine, group: "Developer" },
  { href: "/lab", label: "Component lab", icon: RiFlaskLine, group: "Developer" },
];

const GROUP_ORDER: Cmd["group"][] = ["Threads", "Customize", "Developer"];

/**
 * The sidebar quick-search pill (BoardUI dashboard-sidebar treatment) + the ⌘K
 * command palette it opens. Client-side so it can own the open state, the
 * global ⌘K / Ctrl+K shortcut, and router navigation. Built on the vendored
 * CommandMenu (cmdk + Modal) for behavior — portal, backdrop, focus
 * trap, Esc-to-close — with its visible surfaces restyled on BoardUI tokens.
 */
export function SearchCommand({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const runs = useSidebarThreads();
  const relationships = useSidebarThreadRelationships();
  const [open, setOpen] = React.useState(false);
  // A keyboard-opened palette lands at once; a pointer-opened one animates.
  const [instant, setInstant] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [shortcutHint, setShortcutHint] = React.useState("⌘K");

  // Global ⌘K / Ctrl+K toggles the palette from anywhere; the pill shows the
  // modifier this platform actually uses.
  React.useEffect(() => {
    if (!/Mac|iPhone|iPad|iPod/.test(navigator.platform)) setShortcutHint("Ctrl K");
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setInstant(true);
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setSearch("");
  }

  function go(href: string) {
    handleOpenChange(false);
    router.push(href);
  }

  const query = search.trim().toLowerCase();
  const labAllowed = useLabAccess();
  const matchingCommands = React.useMemo(
    () => filterCommandEntries(labAllowed ? COMMANDS : COMMANDS.filter((cmd) => cmd.href !== "/lab"), query),
    [labAllowed, query],
  );
  const matchingThreads = React.useMemo(() => findThreadMatches(runs, query), [runs, query]);
  const childIds = React.useMemo(
    () => new Set(relationships.filter((item) => item.parentThreadId).map((item) => item.threadId)),
    [relationships],
  );
  const rootMatches = matchingThreads.filter((run) => !childIds.has(run.id));
  // Delegated children match on their own words and say which thread they sit in.
  const childMatches = React.useMemo(
    () => findChildThreadMatches(relationships, query),
    [relationships, query],
  );
  const parentTitle = (parentThreadId: string | null): string =>
    relationships.find((item) => item.threadId === parentThreadId)?.title ??
    runs.find((run) => run.id === parentThreadId)?.prompt ??
    "its parent thread";
  // Words said inside a thread, searched on the server: listed under the title
  // matches, without repeating a thread whose title already matched.
  const messageSearch = useMessageSearch(search);
  const listedThreadIds = new Set([
    ...rootMatches.map((run) => run.id),
    ...childMatches.map((child) => child.threadId),
  ]);
  const messageMatches =
    messageSearch.status === "ready"
      ? visibleMessageMatches(messageSearch.matches, listedThreadIds)
      : [];
  // Until the server answers, "nothing found" would not be true yet.
  const messagesPending = messageSearch.status === "loading" || messageSearch.status === "failed";
  // cmdk hides nothing while the palette filters for it, so an empty group
  // would still show its heading.
  const groupHasRows = (group: Cmd["group"]): boolean =>
    (group === "Threads" && rootMatches.length + childMatches.length > 0) ||
    matchingCommands.some((cmd) => cmd.group === group);
  const matchCount =
    matchingCommands.length + rootMatches.length + childMatches.length + messageMatches.length;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setInstant(false);
          handleOpenChange(true);
        }}
        aria-label={compact ? "Search" : undefined}
        title={compact ? "Search" : undefined}
        className={cx(
          "flex cursor-pointer items-center rounded-full bg-background-tertiary-default text-text-secondary outline-none transition-colors hover:bg-background-tertiary-hover/55 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          compact ? "size-9 justify-center" : "mb-1 w-full gap-2 px-2.5 py-1.5",
        )}
      >
        <span className={cx("flex shrink-0 items-center justify-center", !compact && "w-4")}>
          <RiSearch2Line className="size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
        </span>
        {!compact && <span className="flex-1 text-left text-body-medium">Search</span>}
        {!compact && <Kbd className="ml-auto">{shortcutHint}</Kbd>}
      </button>

      <CommandMenu.Dialog
        open={open}
        onOpenChange={handleOpenChange}
        instant={instant}
        // Every list below is already filtered and ordered (title matches in
        // thread order, message matches from the server); cmdk's own scoring
        // would hide messages whose words are not in the row's value.
        shouldFilter={false}
        overlayClassName="backdrop-blur-[3px]"
        className="max-h-[70vh] w-[min(92vw,40rem)] border border-border-button-default bg-background-primary-default"
      >
        <div className="group/cmd-input flex items-center gap-2.5 px-5">
          <RiSearch2Line className="size-5 shrink-0 text-foreground-icon-tertiary" aria-hidden />
          <CommandMenu.Input
            className="h-14 text-text-primary placeholder:text-text-tertiary"
            placeholder="Type a command"
            value={search}
            onValueChange={setSearch}
          />
        </div>

        <CommandMenu.List>
          {messagesPending ? null : (
            <Command.Empty className="px-5 py-8 text-center text-body-2-regular text-text-tertiary">
              No commands, threads or messages found
            </Command.Empty>
          )}
          {GROUP_ORDER.map((group) => (
            <React.Fragment key={group}>
              {groupHasRows(group) ? (
                <CommandMenu.Group
                  heading={group}
                  className="[&>[cmdk-group-heading]]:text-text-tertiary"
                >
                  {group === "Threads"
                    ? rootMatches.map((run) => {
                        const status = threadStatusPresentation(effectiveThreadStatus(run));
                        const repo = runPrimaryRepo(run);
                        const timestamp = threadActivityTimestamp(run);
                        const title = runTitle(run.prompt);
                        const meta = [status.label, relativeTimeShort(timestamp)].join(" · ");
                        return (
                          <CommandMenu.Item
                            key={`thread:${run.id}`}
                            value={`${title} ${repo ?? ""} ${run.id}`}
                            onSelect={() => go(`/session/${run.id}`)}
                            aria-label={`${title}, ${meta}${repo ? `, ${repo}` : ""}`}
                            className="bg-transparent text-text-primary data-[selected=true]:bg-background-primary-hover"
                          >
                            <span className="flex size-5 shrink-0 items-center justify-center">
                              {status.dot ? (
                                <StatusDot {...status.dot} />
                              ) : (
                                <RiFileTextLine
                                  className="size-4 text-foreground-icon-secondary"
                                  aria-hidden
                                />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{title}</span>
                              {repo ? (
                                <span className="block truncate text-caption-1-regular text-text-tertiary">
                                  {repo}
                                </span>
                              ) : null}
                            </span>
                            <span className="shrink-0 text-caption-1-regular text-text-tertiary tabular-nums">
                              {meta}
                            </span>
                          </CommandMenu.Item>
                        );
                      })
                    : null}
                  {group === "Threads"
                    ? childMatches.map((child) => {
                        const status = threadStatusPresentation(child.status);
                        const inParent = `in ${parentTitle(child.parentThreadId)}`;
                        const meta = [status.label, relativeTimeShort(child.latestActivityAt)].join(
                          " · ",
                        );
                        return (
                          <CommandMenu.Item
                            key={`child:${child.threadId}`}
                            value={`${child.title} ${child.threadId}`}
                            onSelect={() => go(`/session/${child.threadId}`)}
                            aria-label={`${child.title}, ${inParent}, ${meta}`}
                            className="bg-transparent text-text-primary data-[selected=true]:bg-background-primary-hover"
                          >
                            <span className="flex size-5 shrink-0 items-center justify-center">
                              {status.dot ? (
                                <StatusDot {...status.dot} />
                              ) : (
                                <RiFileTextLine
                                  className="size-4 text-foreground-icon-secondary"
                                  aria-hidden
                                />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{child.title}</span>
                              <span className="block truncate text-caption-1-regular text-text-tertiary">
                                {inParent}
                              </span>
                            </span>
                            <span className="shrink-0 text-caption-1-regular text-text-tertiary tabular-nums">
                              {meta}
                            </span>
                          </CommandMenu.Item>
                        );
                      })
                    : null}
                  {matchingCommands
                    .filter((c) => c.group === group)
                    .map((cmd) => (
                      <CommandMenu.Item
                        key={cmd.href}
                        value={cmd.label}
                        onSelect={() => go(cmd.href)}
                        className="bg-transparent text-text-primary data-[selected=true]:bg-background-primary-hover"
                      >
                        <CommandMenu.ItemIcon
                          as={cmd.icon}
                          className="text-foreground-icon-secondary"
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                      </CommandMenu.Item>
                    ))}
                </CommandMenu.Group>
              ) : null}
              {group === "Threads" && (messagesPending || messageMatches.length > 0) ? (
                <CommandMenu.Group
                  heading="Messages"
                  className="[&>[cmdk-group-heading]]:text-text-tertiary"
                >
                  {messageSearch.status === "loading" ? (
                    <Command.Loading className="px-3 py-2 text-body-2-regular text-text-tertiary">
                      Searching messages
                    </Command.Loading>
                  ) : null}
                  {messageSearch.status === "failed" ? (
                    <div role="status" className="px-3 py-2 text-body-2-regular text-text-tertiary">
                      Couldn't search messages. Change the search to try again.
                    </div>
                  ) : null}
                  {messageMatches.map((match) => {
                    const title = runTitle(match.threadPrompt);
                    const inThread = `in ${title}`;
                    const meta = [
                      match.role === "user" ? "You" : "Agent",
                      relativeTimeShort(match.createdAt),
                    ].join(" · ");
                    return (
                      <CommandMenu.Item
                        key={`message:${match.threadId}`}
                        value={`message:${match.threadId}:${match.runId}`}
                        onSelect={() => go(messageMatchHref(match))}
                        aria-label={`${match.snippet}, ${inThread}, ${meta}`}
                        className="bg-transparent text-text-primary data-[selected=true]:bg-background-primary-hover"
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <RiChat3Line
                            className="size-4 text-foreground-icon-secondary"
                            aria-hidden
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{match.snippet}</span>
                          <span className="block truncate text-caption-1-regular text-text-tertiary">
                            {inThread}
                          </span>
                        </span>
                        <span className="shrink-0 text-caption-1-regular text-text-tertiary tabular-nums">
                          {meta}
                        </span>
                      </CommandMenu.Item>
                    );
                  })}
                </CommandMenu.Group>
              ) : null}
            </React.Fragment>
          ))}
        </CommandMenu.List>

        <CommandMenu.Footer>
          <span className="text-caption-1-regular text-text-secondary">
            {matchCount} {query ? (matchCount === 1 ? "result" : "results") : "commands"}
          </span>
          <div className="flex items-center gap-1.5 text-caption-1-regular text-text-tertiary">
            <Kbd>
              <RiCornerDownLeftLine className="size-3" aria-hidden />
            </Kbd>
            <span>select</span>
            <Kbd>esc</Kbd>
            <span>close</span>
          </div>
        </CommandMenu.Footer>
      </CommandMenu.Dialog>
    </>
  );
}
