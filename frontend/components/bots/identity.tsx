import type { AssistantIdentity } from "@/components/chat/conversation";
import { AvatarMark } from "./avatar-mark";
import type { ApiBot } from "./types";

/** The bot a thread belongs to: its home thread, or one delegated to it by an
 *  @mention. Null for a plain thread (or when the roster is unavailable). */
export function botForThread(bots: readonly ApiBot[] | null, threadId: string): ApiBot | null {
  return bots?.find((bot) => bot.homeThreadId === threadId || bot.handoffThreadIds.includes(threadId)) ?? null;
}

/** How the bot answers in a thread it owns: its own mark and name on every turn. */
export function botAssistantIdentity(bot: ApiBot): AssistantIdentity {
  return {
    name: bot.name,
    avatar: <AvatarMark tone={bot.avatarTone} icon={bot.avatarIcon} size="size-5" />,
  };
}

/** The composer lock for a bot that no longer takes messages; null while it does. */
export function botReadOnlyMessage(bot: ApiBot): string | null {
  return bot.archived ? `${bot.name} is archived. Restore it to send messages.` : null;
}
