"use client";

import { RiArrowLeftLine, RiChat1Line, RiComputerLine, RiInformationLine, RiShieldCheckLine } from "@remixicon/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/base/badges/badge";
import { Button } from "@/components/base/buttons/button";
import * as Drawer from "@/components/base/drawer/drawer";
import { Input } from "@/components/base/input/input";
import * as Textarea from "@/components/base/textarea/textarea";
import { backendFetch } from "@/lib/backend-fetch";
import { cx } from "@/utils/cx";
import { ArchiveBotButton } from "./archive-bot";
import { AvatarMark, StateBadge } from "./avatar-mark";
import { PresetSection } from "./bot-preset";
import { BotRepositories } from "./bot-repositories";
import { RoutinesSection } from "./routines-section";
import { type ApiBot, apiErrorText, engineHasComputer, engineLabel, OFFLINE_MESSAGE } from "./types";

/**
 * Header over the bot's thread plus the details drawer behind the info
 * button: the job, the standing rules (editable), the preset (locked once the
 * home thread exists), routines, handoffs, approvals, what it runs on, and
 * archiving at the foot. `threadModel` is the newest turn's model: the
 * composer picks one per turn, so the header, not the preset, shows it.
 */
export function BotThreadHeader({ bot, threadModel }: { bot: ApiBot; threadModel: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(bot.title);
  const [rules, setRules] = useState(bot.rules);
  const [repos, setRepos] = useState([...bot.repos]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty =
    title !== bot.title ||
    rules !== bot.rules ||
    repos.length !== bot.repos.length ||
    repos.some((repo, index) => repo !== bot.repos[index]);
  const model = threadModel ?? bot.model;

  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const response = await backendFetch(`/api/bots/${bot.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), rules: rules.trim(), repos }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        return setError(apiErrorText(data, "Unable to save. Try again."));
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError(OFFLINE_MESSAGE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border-button-default px-5 py-3">
        <Link
          href="/bots"
          aria-label="All bots"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-foreground-icon-secondary outline-none transition-colors hover:bg-background-primary-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring md:hidden"
        >
          <RiArrowLeftLine className="size-4" aria-hidden />
        </Link>
        <AvatarMark tone={bot.avatarTone} icon={bot.avatarIcon} state={bot.state} size="size-8" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-body-medium text-text-primary">
            <span className="truncate" title={bot.name}>
              {bot.name}
            </span>
            {bot.archived ? <Badge>Archived</Badge> : <StateBadge state={bot.state} />}
          </p>
          <p className="flex items-center gap-2 text-caption-1-regular text-text-tertiary">
            <span className="truncate">{bot.title || engineLabel(bot.engine)}</span>
            {model && (
              <span className="shrink-0 text-mono-label" title="Model of the latest turn">
                {model}
              </span>
            )}
          </p>
        </div>
        <Button variant="ghost" size="small" iconOnly leadingIcon={RiInformationLine} aria-label="Bot details" onClick={() => setOpen(true)} />
      </div>

      <Drawer.Root open={open} onOpenChange={setOpen}>
        <Drawer.Content className="flex w-[380px] max-w-full flex-col bg-background-primary-default">
          <Drawer.Header>
            <Drawer.Title className="text-headline-medium text-text-primary">{bot.name}</Drawer.Title>
          </Drawer.Header>
          <Drawer.Body className="flex flex-col gap-6 overflow-y-auto px-5 py-5">
            <div className="flex justify-center">
              <AvatarMark tone={bot.avatarTone} icon={bot.avatarIcon} state={bot.state} size="size-16" />
            </div>

            <Input
              label="What it does"
              placeholder="One line"
              value={title}
              onChange={(value) => {
                setTitle(value);
                setSaved(false);
              }}
            />

            <label className="flex flex-col gap-1.5">
              <span className="text-body-2-medium text-text-primary">Standing rules</span>
              <Textarea.Root
                value={rules}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
                  setRules(event.target.value);
                  setSaved(false);
                }}
                rows={5}
                placeholder="Never send external messages without approval."
              />
              <span className="text-caption-1-regular text-text-tertiary">
                Rules go to the bot with every turn, in its home thread and in any thread handed to it.
              </span>
            </label>

            <BotRepositories
              value={repos}
              onChange={(next) => {
                setRepos(next);
                setSaved(false);
              }}
              locked={bot.presetLocked}
            />

            {(dirty || error || saved) && (
              <div className="flex items-center justify-between gap-3">
                <span
                  role="status"
                  className={cx("text-caption-1-regular", error ? "text-text-error-primary" : "text-text-secondary")}
                >
                  {error ?? (saved && !dirty ? "Saved" : "")}
                </span>
                {dirty && (
                  <Button variant="primary" size="small" onClick={() => void save()}>
                    {busy ? "Saving…" : "Save"}
                  </Button>
                )}
              </div>
            )}

            <PresetSection bot={bot} />

            <RoutinesSection bot={bot} />

            {bot.handoffs > 0 && (
              <section className="flex flex-col gap-1.5">
                <h2 className="text-body-2-medium text-text-primary">Handoffs</h2>
                <p className="text-body-2-regular text-text-secondary">
                  {bot.handoffs === 1 ? "1 handoff thread" : `${bot.handoffs} handoff threads`} opened by @mentions.
                </p>
                <ul className="flex flex-col gap-1">
                  {bot.handoffThreadIds.map((threadId, index) => (
                    <li key={threadId}>
                      <Link
                        href={`/session/${threadId}`}
                        className="text-body-2-regular text-text-primary underline-offset-2 hover:underline"
                      >
                        Handoff thread {index + 1}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="flex flex-col gap-1.5">
              <h2 className="text-body-2-medium text-text-primary">Human input</h2>
              <p className="flex items-start gap-2 text-body-2-regular text-text-secondary">
                <RiShieldCheckLine className="mt-0.5 size-4 shrink-0 text-text-tertiary" aria-hidden />
                {bot.pendingApprovals > 0
                  ? `${bot.pendingApprovals} ${bot.pendingApprovals === 1 ? "request" : "requests"} waiting in the thread.`
                  : "Approvals and questions wait for you in the thread."}
              </p>
            </section>

            <section className="flex flex-col gap-1.5">
              <h2 className="text-body-2-medium text-text-primary">Computer</h2>
              <p className="flex items-start gap-2 text-body-2-regular text-text-secondary">
                {engineHasComputer(bot.engine) ? (
                  <>
                    <RiComputerLine className="mt-0.5 size-4 shrink-0 text-text-tertiary" aria-hidden />
                    Runs on its own isolated computer. Credentials stay in the gateway; no bot can see another bot's logins.
                  </>
                ) : (
                  <>
                    <RiChat1Line className="mt-0.5 size-4 shrink-0 text-text-tertiary" aria-hidden />
                    Chat only: answers from context, no computer or tools.
                  </>
                )}
              </p>
            </section>

            <ArchiveBotButton bot={bot} />
          </Drawer.Body>
        </Drawer.Content>
      </Drawer.Root>
    </>
  );
}
