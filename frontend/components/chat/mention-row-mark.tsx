import type { RemixiconComponentType } from "@remixicon/react";
import { AvatarMark } from "@/components/bots/avatar-mark";

/** What leads a picker row: a bot's own orb, or the row kind's icon. */
export function MentionRowMark({
  bot,
  icon: Icon,
}: {
  bot?: { avatarTone: string; avatarIcon: string };
  icon: RemixiconComponentType;
}) {
  if (bot) return <AvatarMark tone={bot.avatarTone} icon={bot.avatarIcon} size="size-5" />;
  return <Icon className="text-text-secondary size-4 shrink-0" aria-hidden />;
}
