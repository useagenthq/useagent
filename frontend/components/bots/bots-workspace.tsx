import type { ThreadView } from "@/components/chat/load-thread-view";
import { SessionView } from "@/components/chat/session-view";
import { BotThreadHeader } from "./bot-details";
import { BotsRoster } from "./bots-roster";
import { FirstMessage } from "./first-message";
import { BotsOnboarding } from "./onboarding";
import type { ApiBot } from "./types";

/**
 * Two panes, like the reference: the roster and the selected bot's thread.
 * The thread is the real SessionView (windowed like any long session); the
 * bot's details live behind the info button in the thread header.
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
      <BotsRoster initialBots={bots} selectedId={selected?.id ?? null} />
      <div className="flex min-h-0 flex-1 flex-col">
        {!selected ? (
          <BotsOnboarding firstBot={bots.length === 0} />
        ) : (
          <>
            <BotThreadHeader bot={selected} />
            {thread ? (
              <SessionView
                initialThread={thread.thread}
                initialOutline={thread.outline}
                initialRelationshipHint={thread.relationshipHint}
              />
            ) : (
              <FirstMessage bot={selected} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
