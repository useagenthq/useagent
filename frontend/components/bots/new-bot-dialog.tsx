"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import * as Modal from "@/components/base/modal/modal";
import { useCapabilityCatalog } from "@/hooks/use-capability-catalog";
import { backendFetch } from "@/lib/backend-fetch";
import { cx } from "@/utils/cx";
import { AvatarOrb, iconFor, toneClass } from "./avatar-orb";
import { BOT_AVATAR_ICONS, BOT_AVATAR_TONES, engineLabel, type ApiBot } from "./types";

const SUGGESTIONS = [
  {
    name: "Night triage",
    title: "Support engineer",
    icon: "support",
    tone: "cyan",
    rules: "Triage overnight tickets by root cause. Draft replies; never send without approval. File real bugs with repro steps.",
  },
  {
    name: "Reviewer",
    title: "Code reviewer",
    icon: "code",
    tone: "blue",
    rules: "Review every PR for money paths, secrets, and retries first. Never merge without approval.",
  },
] as const;

/**
 * Thin creation flow: name, one job, standing rules, engine, a color and an
 * icon. Suggestions prefill the whole form so the blank state sells the
 * pattern. On success the router lands on the new bot's thread.
 */
export function NewBotDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const { catalog } = useCapabilityCatalog();
  const engines = catalog?.engines.map((engine) => engine.id) ?? [];
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [rules, setRules] = useState("");
  const [engine, setEngine] = useState<string>("");
  const [tone, setTone] = useState<string>("blue");
  const [icon, setIcon] = useState<string>("robot");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosenEngine = engine || engines[0] || "opencode";

  const reset = () => {
    setName("");
    setTitle("");
    setRules("");
    setEngine("");
    setTone("blue");
    setIcon("robot");
    setError(null);
  };

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) {
      setError("Give the bot a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await backendFetch("/api/bots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          title: title.trim(),
          rules: rules.trim(),
          engine: chosenEngine,
          avatarTone: tone,
          avatarIcon: icon,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { bot?: ApiBot; reason?: string; error?: string };
      if (!response.ok || !data.bot) {
        setError(data.reason ?? data.error ?? "Could not create the bot.");
        return;
      }
      onOpenChange(false);
      reset();
      router.push(`/bots/${data.bot.id}`);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content className="max-w-[460px] rounded-3xl border border-border-button-default bg-background-primary-default shadow-dropdown">
        <Modal.Header>
          <div>
            <Modal.Title className="text-title-3-medium text-text-primary">New bot</Modal.Title>
            <Modal.Description className="text-body-2-regular text-text-secondary">
              A name, one job, and the rules it never breaks. It learns the rest on the job.
            </Modal.Description>
          </div>
        </Modal.Header>
        <Modal.Body className="flex flex-col gap-4">
          <div className="flex flex-col items-center gap-3">
            <AvatarOrb tone={tone} icon={icon} size="size-14" />
            <div className="flex items-center gap-1.5">
              {BOT_AVATAR_TONES.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-label={`Color ${option}`}
                  onClick={() => setTone(option)}
                  className={cx(
                    "size-5 rounded-full bg-gradient-to-br transition-transform",
                    toneClass(option),
                    option === tone && "scale-110 ring-2 ring-border-button-hover ring-offset-2 ring-offset-background-primary-default",
                  )}
                />
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              {BOT_AVATAR_ICONS.map((option) => {
                const Icon = iconFor(option);
                return (
                  <button
                    key={option}
                    type="button"
                    aria-label={`Icon ${option}`}
                    onClick={() => setIcon(option)}
                    className={cx(
                      "flex size-7 items-center justify-center rounded-lg text-text-secondary transition-colors",
                      option === icon ? "bg-background-secondary-default text-text-primary" : "hover:bg-background-primary-hover",
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                );
              })}
            </div>
          </div>

          <Input label="Name" placeholder="e.g. Atlas" value={name} onChange={setName} />
          <Input label="One primary job" placeholder="e.g. Reviews every PR before merge" value={title} onChange={setTitle} />

          <label className="flex flex-col gap-1.5">
            <span className="text-body-2-medium text-text-primary">Standing rules</span>
            <textarea
              value={rules}
              onChange={(event) => setRules(event.target.value)}
              rows={3}
              placeholder="Never send external messages without approval."
              className="w-full resize-none rounded-xl border border-border-button-default bg-background-primary-default px-3 py-2 text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder focus:border-border-button-hover"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-body-2-medium text-text-primary">Engine</span>
            <select
              value={chosenEngine}
              onChange={(event) => setEngine(event.target.value)}
              className="w-full rounded-xl border border-border-button-default bg-background-primary-default px-3 py-2 text-body-2-regular text-text-primary outline-none focus:border-border-button-hover"
            >
              {(engines.length ? engines : [chosenEngine]).map((id) => (
                <option key={id} value={id}>
                  {engineLabel(id)}
                </option>
              ))}
            </select>
          </label>

          <div>
            <h3 className="pb-1.5 text-body-2-semibold text-text-primary">Suggestions</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((suggestion) => {
                const Icon = iconFor(suggestion.icon);
                return (
                  <button
                    key={suggestion.name}
                    type="button"
                    onClick={() => {
                      setName(suggestion.name);
                      setTitle(suggestion.title);
                      setRules(suggestion.rules);
                      setIcon(suggestion.icon);
                      setTone(suggestion.tone);
                    }}
                    className="flex items-start gap-2 rounded-xl border border-border-button-default p-2.5 text-left transition-colors hover:bg-background-primary-hover"
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-text-tertiary" aria-hidden />
                    <span>
                      <span className="block text-body-2-medium text-text-primary">{suggestion.name}</span>
                      <span className="block text-caption-1-regular text-text-tertiary">{suggestion.title}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {error && <p className="text-caption-1-regular text-text-error-primary">{error}</p>}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="ghost" size="small">
              Cancel
            </Button>
          </Modal.Close>
          <Button variant="primary" size="small" onClick={() => void submit()}>
            {busy ? "Creating" : "Create bot"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
