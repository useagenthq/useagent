"use client";

// Chat tabs across the top of the transcript: the chats opened in this
// browser, in the order they were opened, the current one selected. Each tab
// is a capsule: the engine's mark, the title, a status dot in the states the
// rail rows use, and a close mark that shows on the current tab and on hover;
// a plus at the end opens a new chat. A tab is a link to its session; closing
// the current one moves to its neighbour. Arrow keys move between tabs, Enter
// opens the focused one, Delete closes it. Titles read from the rail's thread
// list; the list is remembered per user like the pins.

import { RiAddLine, RiCloseLine } from "@remixicon/react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect } from "react";
import { openTabs } from "@/components/chat/chat-tabs-store";
import { engineMarkFor } from "@/components/foundations/icons/vendor-marks";
import { StatusDot } from "@/components/shared/status-dot";
import { chatTitle } from "@/components/shell/chat-title";
import { useSidebarThreads } from "@/components/shell/sidebar-threads-provider";
import { effectiveThreadStatus, threadStatusPresentation } from "@/components/shell/thread-discovery";
import { useSession } from "@/lib/auth";
import { cx } from "@/utils/cx";

export interface ChatTab {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  /** The engine answering the chat, for the mark at the left of the capsule. */
  readonly engine?: string;
  /** The thread's status, for the dot: the same states the rail rows show. */
  readonly status?: Parameters<typeof threadStatusPresentation>[0];
}

const NEW_CHAT_HREF = "/agent/new";

/** What a key pressed on the focused tab does: move focus (wrapping), close it, or nothing. */
export function tabKeyAction(
  key: string,
  index: number,
  count: number,
): { readonly focus: number } | { readonly close: true } | null {
  if (index < 0 || count === 0) return null;
  if (key === "ArrowRight") return { focus: (index + 1) % count };
  if (key === "ArrowLeft") return { focus: (index - 1 + count) % count };
  if (key === "Delete" || key === "Backspace") return { close: true };
  return null;
}

/** The strip itself. Nothing renders until a chat is open. */
export function ChatTabStrip({
  tabs,
  activeId,
  onClose,
}: {
  tabs: readonly ChatTab[];
  activeId: string | null;
  onClose: (id: string) => void;
}) {
  if (tabs.length === 0) return null;
  // Keyboard model: arrow keys move focus between tab links, Enter opens the
  // focused one (native anchor), Delete/Backspace closes it. The handler lives
  // on the pills row (the focused link's DOM ancestor) - see the tablist note
  // below for why the tablist element itself owns nothing in the DOM.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const links = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>('[role="tab"]'));
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    const action = tabKeyAction(event.key, index, links.length);
    if (!action) return;
    event.preventDefault();
    if ("close" in action) onClose(tabs[index].id);
    else links[action.focus]?.focus();
  };
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 px-2">
      {/* The tablist OWNS its tabs through aria-owns instead of DOM containment:
          each capsule also carries a per-tab close mark, and a tablist's DOM
          children must be tabs and only tabs (aria-required-children), while a
          button inside the tab link would nest interactive controls. So the
          capsules live in the sibling pills row below and the tablist re-parents
          the tab links in the accessibility tree, where they belong. */}
      <div
        role="tablist"
        aria-label="Open chats"
        aria-owns={tabs.map((tab) => tab.id).join(" ")}
        data-testid="chat-tabs"
        className="sr-only"
      />
      <div
        data-chat-tabs-pills
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const Mark = engineMarkFor(tab.engine ?? "");
        // No dot until the status is known (the rail list still loading, or a tab
        // older than the list holds): an unknown state is not "done".
        const status = tab.status ? threadStatusPresentation(tab.status) : null;
        return (
          <div
            key={tab.id}
            role="presentation"
            data-active={active ? "" : undefined}
            className={cx(
              "group flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-full pl-2.5 pr-1 transition-colors",
              active
                ? "bg-background-primary-default text-text-primary shadow-sm"
                : "bg-text-primary/[0.06] text-text-secondary hover:bg-text-primary/10 hover:text-text-primary",
            )}
          >
            <Mark className="size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <Link
              role="tab"
              id={tab.id}
              aria-selected={active}
              aria-current={active ? "page" : undefined}
              href={tab.href}
              title={tab.title}
              className="min-w-0 truncate rounded-sm text-body-2-medium outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              {tab.title}
            </Link>
            {status && (
              <span role="img" aria-label={status.label} title={status.label}>
                <StatusDot {...(status.dot ?? { tone: "neutral" })} />
              </span>
            )}
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              onClick={() => onClose(tab.id)}
              className={cx(
                "flex size-5 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-opacity hover:bg-background-tertiary-hover hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring group-hover:opacity-100",
                active ? "opacity-100" : "opacity-0",
              )}
            >
              <RiCloseLine className="size-3.5" aria-hidden />
            </button>
          </div>
        );
      })}
      </div>
      {/* An action, not a tab: kept out of the tablist's owned elements. */}
      <Link
        href={NEW_CHAT_HREF}
        aria-label="New chat"
        title="New chat"
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-text-primary/[0.06] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiAddLine className="size-4" aria-hidden />
      </Link>
    </div>
  );
}

export function ChatTabs() {
  const params = useParams<{ id?: string }>();
  const currentId = typeof params?.id === "string" ? params.id : null;
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const ids = openTabs.useList(userId);
  const runs = useSidebarThreads();
  const router = useRouter();
  useEffect(() => {
    if (currentId) openTabs.add(userId, currentId);
  }, [currentId, userId]);
  const byId = new Map(runs.map((run) => [run.id, run]));
  const tabs = ids.map((id): ChatTab => {
    const run = byId.get(id);
    return {
      id,
      title: run ? chatTitle(run.prompt) : "Chat",
      href: `/session/${id}`,
      engine: run?.engine,
      status: run ? effectiveThreadStatus(run) : undefined,
    };
  });
  return (
    <ChatTabStrip
      tabs={tabs}
      activeId={currentId}
      onClose={(id) => {
        const index = ids.indexOf(id);
        openTabs.remove(userId, id);
        if (id !== currentId) return;
        const next = ids[index + 1] ?? ids[index - 1];
        router.push(next ? `/session/${next}` : NEW_CHAT_HREF);
      }}
    />
  );
}
