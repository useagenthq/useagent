"use client";

import { useRef } from "react";
import type { ThreadView } from "@/components/chat/load-thread-view";
import { cx } from "@/utils/cx";
import { BotThreadHeader } from "./bot-details";
import { BotThreadPane } from "./bot-thread-pane";
import { BotsRoster } from "./bots-roster";
import { FirstMessage } from "./first-message";
import { BotsOnboarding } from "./onboarding";
import { RosterResizer, useRosterWidth } from "./roster-resizer";
import type { ApiBot } from "./types";

/**
 * Two panes, like the reference: the roster and the selected bot's thread.
 * Below md only one shows: the roster at /bots, the thread at /bots/[id] with
 * a back link in its header. The thread is the real SessionView (windowed like
 * any long session); the bot's details live behind the info button in the header.
 * A grip between the two panes drags the roster wider or narrower, like the
 * session rail's grip on the other side of the thread.
 */
export function BotsWorkspace({
  bots,
  selected,
  thread,
}: {
  bots: ApiBot[];
  selected: ApiBot | null;
  thread: ThreadView | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const roster = useRosterWidth({ containerRef, asideRef });
  return (
    <div ref={containerRef} className="flex h-full min-h-0">
      <BotsRoster
        ref={asideRef}
        initialBots={bots}
        selectedId={selected?.id ?? null}
        style={{ "--roster-w": `${roster.width}px` } as React.CSSProperties}
        className={selected ? "hidden md:flex" : "flex"}
      />
      <RosterResizer
        value={roster.width}
        maximum={roster.maximum}
        onMove={roster.resizeFromPointer}
        onCommit={roster.commit}
        onKeyDown={roster.resizeWithKeyboard}
        onReset={roster.reset}
      />
      <div className={cx("min-h-0 min-w-0 flex-1 flex-col", selected ? "flex" : "hidden md:flex")}>
        {!selected ? (
          <BotsOnboarding />
        ) : (
          thread ? (
            <BotThreadPane bot={selected} thread={thread} />
          ) : (
            <>
              <BotThreadHeader bot={selected} threadModel={null} />
              <FirstMessage bot={selected} />
            </>
          )
        )}
      </div>
    </div>
  );
}
