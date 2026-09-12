"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Radio as AriaRadio, RadioGroup as AriaRadioGroup } from "react-aria-components";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import * as Modal from "@/components/base/modal/modal";
import { Select, SelectItem } from "@/components/base/select/select";
import { useCapabilityCatalog } from "@/hooks/use-capability-catalog";
import { backendFetch } from "@/lib/backend-fetch";
import { cx } from "@/utils/cx";
import { AvatarMark, iconFor, toneClass } from "./avatar-mark";
import {
  type ApiBot,
  apiErrorText,
  BOT_AVATAR_ICONS,
  BOT_AVATAR_TONES,
  engineHasComputer,
  engineLabel,
  OFFLINE_MESSAGE,
} from "./types";

const SUGGESTIONS = [
  { name: "Night triage", title: "Works overnight and preps your morning digest", icon: "support", tone: "cyan" },
  { name: "Reviewer", title: "Reads every PR before merge and flags the risky ones", icon: "code", tone: "blue" },
] as const;

const FOCUS_RING = "ring-2 ring-border-focus-ring ring-offset-2 ring-offset-background-primary-default";

/** What the chosen engine gives the bot, said before the bot exists. */
function engineNote(engine: string): string {
  return engineHasComputer(engine)
    ? "Runs on its own isolated computer."
    : "Chat only: answers from context, no computer or tools.";
}

/**
 * The reference's creation screen: one big avatar, a row of colors, a row of
 * shapes, a name, one button. Each swatch row is one radio group (one tab
 * stop, arrows move), and focus opens on the name. The job, rules and model
 * live in the bot's details after creation; the engine is the one thing a bot
 * cannot change later, so it always shows here (a read-only line when only
 * one is ready).
 */
export function NewBotDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const { catalog, loaded } = useCapabilityCatalog();
  const engines = (catalog?.engines ?? []).filter((engine) => engine.ready);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [engine, setEngine] = useState<string | null>(null);
  const [tone, setTone] = useState<string>("blue");
  const [icon, setIcon] = useState<string>("robot");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosenEngine = engine ?? engines[0]?.id ?? null;

  const reset = () => {
    setName("");
    setNameError(null);
    setTitle("");
    setEngine(null);
    setTone("blue");
    setIcon("robot");
    setError(null);
  };

  const failName = (message: string) => {
    setNameError(message);
    nameRef.current?.focus();
  };

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) return failName("Give the bot a name.");
    if (!chosenEngine) return setError("No engine is ready on this server yet.");
    setBusy(true);
    setError(null);
    try {
      const response = await backendFetch("/api/bots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), title: title.trim(), engine: chosenEngine, avatarTone: tone, avatarIcon: icon }),
      });
      const data = (await response.json().catch(() => ({}))) as { bot?: ApiBot; field?: string };
      if (!response.ok || !data.bot) {
        const message = apiErrorText(data, "Unable to create the bot. Try again.");
        return data.field === "name" ? failName(message) : setError(message);
      }
      onOpenChange(false);
      reset();
      router.push(`/bots/${data.bot.id}`);
      router.refresh();
    } catch {
      setError(OFFLINE_MESSAGE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content
        className="max-w-[440px] rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          nameRef.current?.focus();
        }}
      >
        <Modal.Header>
          <div>
            <Modal.Title className="text-title-3-medium text-text-primary">New bot</Modal.Title>
          </div>
        </Modal.Header>
        <Modal.Body className="flex flex-col gap-6 pt-2">
          <div className="flex flex-col items-center gap-5">
            <AvatarMark tone={tone} icon={icon} size="size-16" />
            <AriaRadioGroup aria-label="Color" value={tone} onChange={setTone} className="flex items-center gap-2">
              {BOT_AVATAR_TONES.map((option) => (
                <AriaRadio
                  key={option}
                  value={option}
                  aria-label={`Color ${option}`}
                  className={({ isSelected, isFocusVisible }) =>
                    cx(
                      "size-6 cursor-pointer rounded-full transition-transform",
                      toneClass(option),
                      isSelected && "scale-110 ring-2 ring-border-button-hover ring-offset-2 ring-offset-background-primary-default",
                      isFocusVisible && FOCUS_RING,
                    )
                  }
                />
              ))}
            </AriaRadioGroup>
            <AriaRadioGroup aria-label="Icon" value={icon} onChange={setIcon} className="flex items-center gap-1.5">
              {BOT_AVATAR_ICONS.map((option) => {
                const Icon = iconFor(option);
                return (
                  <AriaRadio
                    key={option}
                    value={option}
                    aria-label={`Icon ${option}`}
                    className={({ isSelected, isFocusVisible }) =>
                      cx(
                        "flex size-8 cursor-pointer items-center justify-center rounded-lg transition-colors",
                        isSelected ? cx(toneClass(tone), "text-text-white-0") : "text-text-tertiary hover:bg-background-primary-hover",
                        isFocusVisible && FOCUS_RING,
                      )
                    }
                  >
                    <Icon className="size-4" />
                  </AriaRadio>
                );
              })}
            </AriaRadioGroup>
          </div>

          <div className="flex flex-col gap-3">
            <Input
              ref={nameRef}
              label="Name"
              placeholder="Bot name"
              value={name}
              onChange={(value) => {
                setName(value);
                setNameError(null);
              }}
              isInvalid={nameError !== null}
              hint={nameError ?? undefined}
            />
            <Input label="What it does" placeholder="One line, optional" value={title} onChange={setTitle} />
            <div className="flex flex-col gap-1.5">
              <span className="text-body-2-medium text-text-primary">Engine</span>
              {engines.length > 1 ? (
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
              ) : (
                <p className="text-body-2-regular text-text-primary">
                  {chosenEngine ? engineLabel(chosenEngine) : loaded ? "No engine is ready on this server yet." : "Checking which engines are ready"}
                </p>
              )}
              {chosenEngine && <p className="text-caption-1-regular text-text-secondary">{engineNote(chosenEngine)}</p>}
            </div>
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
                      setNameError(null);
                      setTitle(suggestion.title);
                      setIcon(suggestion.icon);
                      setTone(suggestion.tone);
                    }}
                    className="flex items-start gap-3 rounded-2xl border border-border-button-default p-3 text-left transition-colors hover:bg-background-primary-hover"
                  >
                    <span className={cx("flex size-10 shrink-0 items-center justify-center rounded-full text-text-white-0", toneClass(suggestion.tone))}>
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-body-medium text-text-primary">{suggestion.name}</span>
                      <span className="line-clamp-2 text-body-2-regular text-text-secondary">{suggestion.title}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <p role="alert" className="text-body-2-regular text-text-error-primary">
              {error}
            </p>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="secondary" size="small">
              Cancel
            </Button>
          </Modal.Close>
          <Button variant="primary" size="small" onClick={() => void submit()}>
            {busy ? "Creating…" : "Create bot"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
