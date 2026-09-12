import type { ThreadView } from "@/components/chat/load-thread-view";
import { cx } from "@/utils/cx";
import { BotThreadHeader } from "./bot-details";
import { BotThreadPane } from "./bot-thread-pane";
import { BotsRoster } from "./bots-roster";
import { FirstMessage } from "./first-message";
import { BotsOnboarding } from "./onboarding";
import type { ApiBot } from "./types";

/**
 * Two panes, like the reference: the roster and the selected bot's thread.
 * Below md only one shows: the roster at /bots, the thread at /bots/[id] with
 * a back link in its header. The thread is the real SessionView (windowed like
 * any long session); the bot's details live behind the info button in the header.
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
  return (
    <div className="flex h-full min-h-0">
      <BotsRoster initialBots={bots} selectedId={selected?.id ?? null} className={selected ? "hidden md:flex" : "flex"} />
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
