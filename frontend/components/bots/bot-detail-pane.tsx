import { RiComputerLine, RiShieldCheckLine } from "@remixicon/react";
import { AvatarOrb } from "./avatar-orb";
import { engineLabel, type ApiBot } from "./types";

/**
 * Right pane: what makes this bot this bot. Standing rules, the preset, and
 * the two lines competitors cannot print - approvals do not expire, and each
 * bot works on its own isolated computer with credentials held by the gateway.
 */
export function BotDetailPane({ bot }: { bot: ApiBot }) {
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l border-border-button-default px-4 py-5 xl:flex">
      <div className="flex flex-col items-center gap-2 text-center">
        <AvatarOrb tone={bot.avatarTone} icon={bot.avatarIcon} state={bot.state} size="size-10" />
        <div>
          <p className="text-headline-medium text-text-primary">{bot.name}</p>
          <p className="text-body-2-regular text-text-secondary">
            {bot.title ? `${bot.title} · ` : ""}
            {engineLabel(bot.engine)}
            {bot.model ? ` · ${bot.model}` : ""}
          </p>
        </div>
      </div>

      <section>
        <h3 className="pb-1.5 text-body-2-semibold text-text-primary">Standing rules</h3>
        <p className="text-body-2-regular leading-relaxed text-text-secondary">
          {bot.rules.trim() ? bot.rules : "None yet. Rules go into the first turn of the home thread and stay in force."}
        </p>
      </section>

      <section>
        <h3 className="pb-1.5 text-body-2-semibold text-text-primary">Skills</h3>
        {bot.skillIds.length === 0 ? (
          <p className="text-body-2-regular text-text-tertiary">No skills pinned.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {bot.skillIds.map((id) => (
              <span
                key={id}
                className="rounded-md bg-background-secondary-default px-1.5 py-0.5 font-mono text-caption-1-regular text-text-secondary"
              >
                {id}
              </span>
            ))}
          </div>
        )}
      </section>

      {bot.repos.length > 0 && (
        <section>
          <h3 className="pb-1.5 text-body-2-semibold text-text-primary">Repositories</h3>
          <div className="flex flex-wrap gap-1.5">
            {bot.repos.map((repo) => (
              <span
                key={repo}
                className="rounded-md bg-background-secondary-default px-1.5 py-0.5 font-mono text-caption-1-regular text-text-secondary"
              >
                {repo}
              </span>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="pb-1.5 text-body-2-semibold text-text-primary">Approvals</h3>
        <p className="flex items-start gap-1.5 text-body-2-regular leading-relaxed text-text-secondary">
          <RiShieldCheckLine className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden />
          {bot.pendingApprovals > 0
            ? `${bot.pendingApprovals} request${bot.pendingApprovals === 1 ? "" : "s"} waiting in the thread.`
            : "Anything external - sends, publishes, pushes - waits for you in the thread."}
        </p>
      </section>

      <section>
        <h3 className="pb-1.5 text-body-2-semibold text-text-primary">Computer</h3>
        <p className="flex items-start gap-1.5 text-body-2-regular leading-relaxed text-text-secondary">
          <RiComputerLine className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden />
          {bot.name} runs on its own isolated computer. Credentials stay in the gateway - no bot can see another bot's logins.
        </p>
      </section>
    </aside>
  );
}
