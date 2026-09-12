import type { ThreadView } from "@/components/chat/load-thread-view";
import { SessionView } from "@/components/chat/session-view";
import { cx } from "@/utils/cx";
import { AvatarMark } from "./avatar-mark";
import { BotThreadHeader } from "./bot-details";
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
          <>
            {/* The model is per turn (the composer's picker is live), so the header shows the newest turn's. */}
            <BotThreadHeader bot={selected} threadModel={thread?.thread.at(-1)?.model ?? null} />
            {thread ? (
              <SessionView
                initialThread={thread.thread}
                initialOutline={thread.outline}
                initialRelationshipHint={thread.relationshipHint}
                assistantIdentity={{
                  name: selected.name,
                  avatar: <AvatarMark tone={selected.avatarTone} icon={selected.avatarIcon} size="size-5" />,
                }}
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
