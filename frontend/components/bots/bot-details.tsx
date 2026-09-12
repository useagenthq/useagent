"use client";

import { RiComputerLine, RiInformationLine, RiShieldCheckLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/base/buttons/button";
import * as Drawer from "@/components/base/drawer/drawer";
import { Input } from "@/components/base/input/input";
import * as Textarea from "@/components/base/textarea/textarea";
import { backendFetch } from "@/lib/backend-fetch";
import { AvatarMark } from "./avatar-mark";
import { type ApiBot, apiErrorText, engineLabel } from "./types";
import { RoutinesSection } from "./routines-section";

/**
 * Header over the bot's thread plus the details drawer behind the info
 * button: the job, the standing rules (editable), the preset (locked once the
 * home thread exists), approvals, and the isolated-computer line.
 */
export function BotThreadHeader({ bot }: { bot: ApiBot }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(bot.title);
  const [rules, setRules] = useState(bot.rules);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = title !== bot.title || rules !== bot.rules;

  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const response = await backendFetch(`/api/bots/${bot.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), rules: rules.trim() }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        return setError(apiErrorText(data, "Could not save."));
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border-button-default px-5 py-3">
        <AvatarMark tone={bot.avatarTone} icon={bot.avatarIcon} state={bot.state} size="size-8" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-medium text-text-primary">{bot.name}</p>
          <p className="truncate text-caption-1-regular text-text-tertiary">
            {bot.title || engineLabel(bot.engine)}
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
            <div className="flex flex-col items-center gap-3 text-center">
              <AvatarMark tone={bot.avatarTone} icon={bot.avatarIcon} state={bot.state} size="size-16" />
              <p className="text-body-2-regular text-text-secondary">
                {engineLabel(bot.engine)}
                {bot.model ? ` · ${bot.model}` : ""}
              </p>
            </div>

            <Input label="What it does" placeholder="One line" value={title} onChange={setTitle} />

            <label className="flex flex-col gap-1.5">
              <span className="text-body-2-medium text-text-primary">Standing rules</span>
              <Textarea.Root
                value={rules}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setRules(event.target.value)}
                rows={5}
                placeholder="Never send external messages without approval."
              />
              <span className="text-caption-1-regular text-text-tertiary">
                Rules go to the bot with every turn, in its home thread and in any thread handed to it.
              </span>
            </label>

            {(dirty || error) && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-caption-1-regular text-text-error-primary">{error ?? ""}</span>
                <Button variant="primary" size="small" onClick={() => void save()}>
                  {busy ? "Saving" : "Save"}
                </Button>
              </div>
            )}

            <section className="flex flex-col gap-1.5">
              <h3 className="text-body-2-medium text-text-primary">Preset</h3>
              <p className="text-body-2-regular text-text-secondary">
                {engineLabel(bot.engine)}
                {bot.model ? ` · ${bot.model}` : ""}
                {bot.skillIds.length > 0 ? ` · skill ${bot.skillIds[0]}` : ""}
                {bot.repos.length > 0 ? ` · ${bot.repos.join(", ")}` : ""}
                {` · ${bot.memoryScope} memory`}
              </p>
              {bot.presetLocked && (
                <p className="text-caption-1-regular text-text-tertiary">
                  Fixed since the first message: the home thread runs on it.
                </p>
              )}
            </section>

            <RoutinesSection bot={bot} />

            <section className="flex flex-col gap-1.5">
              <h3 className="text-body-2-medium text-text-primary">Approvals</h3>
              <p className="flex items-start gap-2 text-body-2-regular text-text-secondary">
                <RiShieldCheckLine className="mt-0.5 size-4 shrink-0 text-text-tertiary" aria-hidden />
                {bot.pendingApprovals > 0
                  ? `${bot.pendingApprovals} waiting in the thread.`
                  : "Anything external waits for you in the thread."}
              </p>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className="text-body-2-medium text-text-primary">Computer</h3>
              <p className="flex items-start gap-2 text-body-2-regular text-text-secondary">
                <RiComputerLine className="mt-0.5 size-4 shrink-0 text-text-tertiary" aria-hidden />
                Runs on its own isolated computer. Credentials stay in the gateway; no bot can see another bot's logins.
              </p>
            </section>
          </Drawer.Body>
        </Drawer.Content>
      </Drawer.Root>
    </>
  );
}
