"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import * as Modal from "@/components/base/modal/modal";
import { Select, SelectItem } from "@/components/base/select/select";
import { useCapabilityCatalog } from "@/hooks/use-capability-catalog";
import { backendFetch } from "@/lib/backend-fetch";
import { cx } from "@/utils/cx";
import { AvatarMark, iconFor, toneClass } from "./avatar-mark";
import { type ApiBot, apiErrorText, BOT_AVATAR_ICONS, BOT_AVATAR_TONES, engineLabel } from "./types";

const SUGGESTIONS = [
  { name: "Night triage", title: "Works overnight and preps your morning digest", icon: "support", tone: "cyan" },
  { name: "Reviewer", title: "Reads every PR before merge and flags the risky ones", icon: "code", tone: "blue" },
] as const;

/**
 * The reference's creation screen: one big avatar, a row of colors, a row of
 * shapes, a name, one button. The job, rules and model live in the bot's
 * details after creation; the engine is the one thing a bot cannot change
 * later, so it stays here (defaulting to the first ready engine).
 */
export function NewBotDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const { catalog } = useCapabilityCatalog();
  const engines = (catalog?.engines ?? []).filter((engine) => engine.ready);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [engine, setEngine] = useState<string | null>(null);
  const [tone, setTone] = useState<string>("blue");
  const [icon, setIcon] = useState<string>("robot");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosenEngine = engine ?? engines[0]?.id ?? null;

  const reset = () => {
    setName("");
    setTitle("");
    setEngine(null);
    setTone("blue");
    setIcon("robot");
    setError(null);
  };

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) return setError("Give the bot a name.");
    if (!chosenEngine) return setError("No engine is ready on this server yet.");
    setBusy(true);
    setError(null);
    try {
      const response = await backendFetch("/api/bots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), title: title.trim(), engine: chosenEngine, avatarTone: tone, avatarIcon: icon }),
      });
      const data = (await response.json().catch(() => ({}))) as { bot?: ApiBot };
      if (!response.ok || !data.bot) return setError(apiErrorText(data, "Could not create the bot."));
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
      <Modal.Content className="max-w-[440px] rounded-3xl border border-border-button-default bg-background-primary-default shadow-dropdown">
        <Modal.Header>
          <div>
            <Modal.Title className="text-title-3-medium text-text-primary">New bot</Modal.Title>
          </div>
        </Modal.Header>
        <Modal.Body className="flex flex-col gap-6 pt-2">
          <div className="flex flex-col items-center gap-5">
            <AvatarMark tone={tone} icon={icon} size="size-16" />
            <div className="flex items-center gap-2">
              {BOT_AVATAR_TONES.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-label={`Color ${option}`}
                  aria-pressed={option === tone}
                  onClick={() => setTone(option)}
                  className={cx(
                    "size-6 rounded-full transition-transform",
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
                    aria-pressed={option === icon}
                    onClick={() => setIcon(option)}
                    className={cx(
                      "flex size-8 items-center justify-center rounded-lg transition-colors",
                      option === icon ? cx(toneClass(tone), "text-text-white-0") : "text-text-tertiary hover:bg-background-primary-hover",
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <Input label="Name" placeholder="New bot" value={name} onChange={setName} />
            <Input label="What it does" placeholder="One line, optional" value={title} onChange={setTitle} />
            {engines.length > 1 && (
              <label className="flex flex-col gap-1.5">
                <span className="text-body-2-medium text-text-primary">Engine</span>
                <Select
                  aria-label="Engine"
                  selectedKey={chosenEngine ?? undefined}
                  onSelectionChange={(key) => setEngine(String(key))}
                >
                  {engines.map((option) => (
                    <SelectItem key={option.id} id={option.id} textValue={engineLabel(option.id)}>
                      {engineLabel(option.id)}
                    </SelectItem>
                  ))}
                </Select>
              </label>
            )}
          </div>

          <div>
            <p className="pb-2 text-body-2-regular text-text-tertiary">Suggestions</p>
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
                      setIcon(suggestion.icon);
                      setTone(suggestion.tone);
                    }}
                    className="flex items-center gap-3 rounded-2xl border border-border-button-default p-3 text-left transition-colors hover:bg-background-primary-hover"
                  >
                    <span className={cx("flex size-10 shrink-0 items-center justify-center rounded-full text-text-white-0", toneClass(suggestion.tone))}>
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-body-medium text-text-primary">{suggestion.name}</span>
                      <span className="block text-body-2-regular text-text-secondary">{suggestion.title}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {error && <p className="text-body-2-regular text-text-error-primary">{error}</p>}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="ghost" size="small">
              Cancel
            </Button>
          </Modal.Close>
          <Button variant="primary" size="small" onClick={() => void submit()}>
            {busy ? "Creating" : "Get started"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
