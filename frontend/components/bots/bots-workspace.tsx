import { RiRobot2Line } from "@remixicon/react";
import { SessionView } from "@/components/chat/session-view";
import type { ApiRun } from "@/components/chat/types";
import { BotDetailPane } from "./bot-detail-pane";
import { BotsRoster } from "./bots-roster";
import { FirstMessage } from "./first-message";
import type { ApiBot } from "./types";

function NothingSelected() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <RiRobot2Line className="size-6 text-text-tertiary" aria-hidden />
      <p className="text-headline-medium text-text-primary">Pick a bot</p>
      <p className="max-w-sm text-body-2-regular text-text-tertiary">
        Each bot is a standing job over its own thread. Open one to see its work, or create a new one.
      </p>
    </div>
  );
}

/**
 * Three panes: roster (client, polls), the selected bot's home thread rendered
 * by the real SessionView (or the first-message prompt when it has none), and
 * the bot's detail pane.
 */
export function BotsWorkspace({
  bots,
  selected,
  thread,
}: {
  bots: ApiBot[];
  selected: ApiBot | null;
  thread: ApiRun[];
}) {
  return (
    <div className="flex h-full min-h-0">
      <BotsRoster initialBots={bots} selectedId={selected?.id ?? null} />
      <div className="flex min-h-0 flex-1 flex-col">
        {!selected ? (
          <NothingSelected />
        ) : thread.length > 0 ? (
          <SessionView initialThread={thread} />
        ) : (
          <FirstMessage bot={selected} />
        )}
      </div>
      {selected && <BotDetailPane bot={selected} />}
    </div>
  );
}
