"use client";

import { useRef, useState } from "react";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowUpLine,
  RiStopFill,
  RiErrorWarningLine,
  RiMicLine,
  RiToolsLine,
} from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";
import {
  PromptInput,
  PromptInputTextarea,
} from "@/components/prompt-kit/prompt-input";
import { Loader } from "@/components/prompt-kit/loader";
import { ModelPicker } from "@/components/chat/engine-picker";
import { MemoryScopePicker } from "@/components/chat/memory-scope-picker";
import {
  AgentChip,
  ChooseAgentPopover,
  type Agent,
} from "@/components/chat/agent-command";
import {
  commandOptionId,
  filterCommands,
  parseCommandIntent,
  SlashCommandPopover,
  slashInsertText,
  type CommandPickerStatus,
  type SlashCommand,
} from "@/components/chat/slash-command";
import type { CommandCatalogState } from "@/components/chat/canonical-timeline";
import { ChatModelMenu, type ChatModelOption } from "@/components/chat/chat-model-menu";
import type { EngineId, MemoryScope } from "@/components/chat/types";

type Variant = "hero" | "compact";

/**
 * Submit a composed prompt. `idempotencyKey` is a stable per-submission id the
 * handler forwards as the backend `Idempotency-Key`, so a lost-response retry
 * observes the original run instead of duplicating it. `memoryScope` is the
 * team-memory pool the run reads/writes. Reject to signal failure: the composer
 * restores the draft and shows a retry state (reusing the same key). A
 * synchronous (void) handler is treated as accepted.
 */
export type ComposerSubmit = (
  prompt: string,
  engine: EngineId,
  model: string,
  idempotencyKey: string,
  memoryScope: MemoryScope,
  /** A TYPED native-command intent, set ONLY when the prompt is a `/known-command ...` from the
   *  active catalog (see parseCommandIntent). The run API re-validates it and, only then,
   *  delivers the command verbatim. Absent for an ordinary prompt. */
  command?: { name: string; args: string } | null,
) => void | Promise<void>;

export type ComposerProps = {
  variant?: Variant;
  placeholder?: string;
  engine?: EngineId;
  defaultEngine?: EngineId;
  pending?: boolean;
  /** Disable prompt submission while a structured multi-question request must
   * be completed in its card. Unlike `pending`, this is not a loading state. */
  locked?: boolean;
  autoFocus?: boolean;
  className?: string;
  /** Enable the "/" Choose-Agent slash command (default on hero). */
  enableAgentCommand?: boolean;
  /** Show the per-message model picker (default true). The lightweight Chat
   *  surface talks to ONE backend-configured model, so it hides this rather than
   *  present a control that changes nothing. */
  enableModelPicker?: boolean;
  /** Surface treatment. Both flip with the app theme (never a white island). "white"
   *  is the lightweight Chat-page variant: a softer rounded-3xl pill; the card still
   *  uses bg-bg-white-0, so it's a clean white pill in light mode and a native dark
   *  pill in dark mode. "default" is the standard card used everywhere else. */
  surface?: "default" | "white";
  /** Real MODEL picker for the lightweight Chat surface. When provided, a labeled
   *  trigger opens the "Choose model" card (the honest replacement for the
   *  placeholder agent picker) and `modelMenu.value` is the model submitted -
   *  supersedes the internal model state + the "/" agent command. */
  modelMenu?: {
    options: ChatModelOption[];
    value: string;
    onChange: (value: string) => void;
  };
  /** Starting model for the picker (thread's current model on replies). */
  defaultModel?: string;
  /** Starting memory scope (a reply inherits the thread's current scope). */
  defaultMemoryScope?: MemoryScope;
  /** Engine slash commands for "/" autocomplete (reply composer, live thread). */
  commands?: SlashCommand[];
  /** The honest command-catalog state (loading/unavailable/error/ready) + provider source, so the
   *  "/" popover shows a truthful section label + state rows. When present it supersedes
   *  `commands` (its ready catalog is used); absent -> the plain `commands` behavior (status ready). */
  commandState?: CommandCatalogState;
  onSubmit: ComposerSubmit;
  /** A turn is running in this thread - the send button becomes a Stop control
   *  while the input is empty (ChatGPT/opencode pattern); typing turns it back
   *  into Send so a reply can still be queued. */
  running?: boolean;
  stopping?: boolean;
  /** Visible failure from the durable cancel request; the Stop control remains retryable. */
  stopError?: string | null;
  onStop?: () => void;
};

/**
 * The Skynet composer — a restyled prompt-kit `PromptInput`. Default `hero`
 * arrangement matches the HeyRico reference (heyrico-clean-design-2): a large
 * rounded card with "Ask anything…", a left cluster (+ · tools) and a right
 * cluster (✳ engine picker · mic · blue circular send).
 * Optional "/" Choose-Agent slash command that renders the selection as a
 * pink inline chip, and a "/" command autocomplete on reply composers.
 *
 * The card surface/border swap via the AlignUI theme ladder; the blue send and
 * blue accents use the literal blue scale (which doesn't flip), so the anatomy
 * reads identically on the light card and the dark #20201f surface.
 */
export function Composer({
  variant = "hero",
  placeholder = "Ask anything...",
  engine: engineProp,
  defaultEngine = "opencode",
  pending = false,
  locked = false,
  autoFocus = false,
  className,
  enableAgentCommand,
  enableModelPicker = true,
  surface = "default",
  modelMenu,
  defaultModel = "claude-opus-5",
  defaultMemoryScope = "org",
  commands,
  commandState,
  onSubmit,
  running = false,
  stopping = false,
  stopError,
  onStop,
}: ComposerProps) {
  const [value, setValue] = useState("");
  // Single fixed engine here; there is no setter (this composer serves replies -
  // a thread is pinned to one engine - and the no-sandbox Chat surface). Engine
  // SELECTION for a new task lives in NewTaskComposer. Kept as state so `engineProp`
  // can still override it without changing the call sites.
  const [engineState] = useState<EngineId>(defaultEngine);
  const [model, setModel] = useState(defaultModel);
  const [memoryScope, setMemoryScope] = useState<MemoryScope>(defaultMemoryScope);
  const [command, setCommand] = useState<Agent | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [cmdHighlight, setCmdHighlight] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  // Prompt-submission transaction: `submitting` guards the in-flight await (no
  // duplicate submit); `failed` surfaces an explicit retry state; `retry` holds
  // the draft + its idempotency key so a resend of the same text reuses the key.
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const retry = useRef<{ text: string; key: string } | null>(null);

  const engine = engineProp ?? engineState;
  const hero = variant === "hero";
  const white = surface === "white";
  // The real chat model picker (honest options) supersedes the placeholder agent
  // picker on this composer when supplied.
  const activeModelOption = modelMenu?.options.find((o) => o.value === modelMenu.value);
  const allowAgent = enableAgentCommand ?? hero;
  const slashActive = allowAgent && !command && value.trimStart().startsWith("/");
  const showAgentPopover = slashActive || toolsOpen;
  const busy = pending || submitting;
  const blocked = busy || locked;
  const canSend = value.trim().length > 0 && !blocked;
  // Circular blue send button - reads correctly on BOTH the dark (#20201f) and the
  // light composer surface, so it theme-follows instead of forcing a static color.
  const sendToneClass = "bg-blue-500 text-white hover:bg-blue-600";

  // Slash-command autocomplete: live while the FIRST token is being typed
  // ("/rev" but not "/review changes"). A trailing space ends completion.
  // The honest command-catalog state (Phase 7) supersedes the plain `commands` prop when present:
  // its READY catalog is the source of options, and its status drives the loading/unavailable/
  // error rows so the picker is always truthful instead of "just nothing".
  const catalogStatus: CommandPickerStatus = commandState?.status ?? "ready";
  const catalogSource = commandState?.status === "unavailable" || commandState?.status === "ready" ? commandState.source : undefined;
  const catalogCommands: SlashCommand[] = commandState
    ? commandState.status === "ready"
      ? commandState.commands.map((c) => ({ name: c.name, description: c.description ?? null, input: c.input ?? null }))
      : []
    : commands ?? [];
  const cmdToken = /^\/([^\s]*)$/.exec(value.trimStart())?.[1];
  const slashTyped = !allowAgent && !cmdDismissed && cmdToken !== undefined;
  const cmdMatches = slashTyped ? filterCommands(catalogCommands, cmdToken ?? "") : [];
  // Show the popover while typing "/" when there is SOMETHING honest to show: matches, a
  // non-ready state row (loading/unavailable/error), or a ready-but-no-match note when a catalog
  // exists. A ready+empty catalog (the engine advertises none) shows nothing.
  const cmdActive =
    slashTyped && (cmdMatches.length > 0 || catalogStatus !== "ready" || catalogCommands.length > 0);
  const cmdHighlightedName =
    cmdMatches.length > 0 ? cmdMatches[Math.min(cmdHighlight, cmdMatches.length - 1)]?.name : undefined;

  function pickCommand(cmd: SlashCommand) {
    setValue(slashInsertText(cmd.name)); // verbatim `/name ` - sent as-is to the resident session
    setCmdHighlight(0);
  }

  function handleCmdKeys(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!cmdActive) return;
    // Escape closes the popover in any state (loading/unavailable/error/list).
    if (e.key === "Escape") {
      e.preventDefault();
      setCmdDismissed(true);
      return;
    }
    // Navigation + selection only apply when there are actual command options (a state row
    // has none - guard against a `% 0` / picking `undefined`).
    if (cmdMatches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCmdHighlight((h) => (h + 1) % cmdMatches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCmdHighlight((h) => (h - 1 + cmdMatches.length) % cmdMatches.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const selected = cmdMatches[Math.min(cmdHighlight, cmdMatches.length - 1)];
      if (selected) pickCommand(selected);
    }
  }

  async function submit() {
    const raw = value; // the ORIGINAL bytes, before any trim
    const text = raw.trim();
    if (!text || blocked) return; // duplicate-submit / structured-question guard
    // Reuse the idempotency key when resending the SAME failed text, so a retry
    // after an ambiguous failure observes the original run instead of starting a
    // duplicate; fresh text gets a fresh key.
    const key =
      retry.current && retry.current.text === text
        ? retry.current.key
        : crypto.randomUUID();
    setSubmitting(true);
    setFailed(false);
    setValue(""); // optimistic clear — the pending bubble shows the text meanwhile
    try {
      // A typed native-command intent when the text is a `/known-command ...` for THIS
      // composer's catalog; else null (an ordinary prompt). Parse from the RAW value (not the
      // trimmed text) so a command's argument bytes reach the backend EXACTLY as typed - the
      // backend rebuilds `/name <args>` verbatim from this intent. The backend re-validates.
      const intent = commands ? parseCommandIntent(raw, commands) : null;
      // The chat model picker (when present) owns the model; else the internal state.
      await onSubmit(text, engine, modelMenu?.value ?? model, key, memoryScope, intent);
      retry.current = null; // accepted — drop the retry key
    } catch {
      // Never silently swallow: restore the draft and show an explicit failed
      // state; keep the key so the next send retries idempotently.
      retry.current = { text, key };
      setValue(text);
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  }

  function pickAgent(agent: Agent) {
    setCommand(agent);
    setValue("");
    setToolsOpen(false);
  }

  return (
    // The composer THEME-FOLLOWS: its card uses bg-bg-white-0 (white in light mode,
    // #20201f in dark) so it reads as the reference's clean white pill in light and
    // a native dark pill in dark - never a white island clashing with the dark page.
    <div className={cn("relative w-full", className)}>
      {showAgentPopover && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-full">
          <ChooseAgentPopover query={slashActive ? value : ""} onSelect={pickAgent} />
        </div>
      )}

      {modelMenu && modelMenuOpen && (
        <>
          {/* Backdrop so a click anywhere closes the menu. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setModelMenuOpen(false)}
          />
          <div className="absolute bottom-full left-0 z-30 mb-2 w-full">
            <ChatModelMenu
              options={modelMenu.options}
              value={modelMenu.value}
              onSelect={(v) => {
                modelMenu.onChange(v);
                setModelMenuOpen(false);
              }}
            />
          </div>
        </>
      )}

      {cmdActive && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-full">
          <SlashCommandPopover
            matches={cmdMatches}
            highlight={Math.max(0, Math.min(cmdHighlight, cmdMatches.length - 1))}
            onSelect={pickCommand}
            status={catalogStatus}
            source={catalogSource}
          />
        </div>
      )}

      {failed && (
        <div
          role="alert"
          className="text-error-base mb-1.5 flex items-center gap-1.5 px-1 text-paragraph-xs"
        >
          <RiErrorWarningLine className="size-3.5 shrink-0" aria-hidden />
          Couldn&apos;t send - your message is restored. Press send to try again.
        </div>
      )}

      {stopError && (
        <div
          role="alert"
          data-testid="stop-error"
          className="text-error-base mb-1.5 flex items-center gap-1.5 px-1 text-paragraph-xs"
        >
          <RiErrorWarningLine className="size-3.5 shrink-0" aria-hidden />
          Couldn&apos;t stop this run: {stopError}. Try again.
        </div>
      )}

      {/* No overflow-hidden here: the engine-picker popover opens upward past
          the card edge and must not be clipped. */}
      <div
        className={cn(
          "border-stroke-soft-200 bg-bg-white-0 shadow-regular-md border",
          // A larger radius reads as the reference's soft rounded pill on white.
          white ? "rounded-3xl" : "rounded-2xl",
        )}
      >
        <PromptInput
          value={value}
          onValueChange={(v) => {
            setValue(v);
            setCmdDismissed(false);
            setCmdHighlight(0);
            if (failed) setFailed(false); // editing dismisses the failed state
          }}
          onSubmit={submit}
          isLoading={pending}
          maxHeight={hero ? 220 : 150}
          className={cn(
            "cursor-text rounded-none border-0 bg-transparent shadow-none",
            hero ? "p-3 md:p-4" : "p-2.5",
          )}
        >
          <div className="flex items-start gap-1.5 px-1">
            {command && (
              <span className="pt-1">
                <AgentChip agent={command} onRemove={() => setCommand(null)} />
              </span>
            )}
            <PromptInputTextarea
              autoFocus={autoFocus}
              disabled={locked}
              placeholder={command ? "" : placeholder}
              // ARIA combobox/listbox wiring for the "/" command popover: announce that a list is
              // available, whether it is open, and which option is active (so a screen reader reads
              // the highlighted command as the user arrows through it).
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={cmdActive}
              aria-controls={cmdActive ? "slashcmd-label" : undefined}
              aria-activedescendant={cmdActive && cmdHighlightedName ? commandOptionId(cmdHighlightedName) : undefined}
              onKeyDown={(e) => {
                handleCmdKeys(e);
                if (e.key === "Backspace" && value === "" && command) {
                  setCommand(null);
                }
              }}
              className={cn(
                "flex-1",
                hero ? "pt-1 text-paragraph-lg" : "text-paragraph-sm",
              )}
            />
          </div>

          {/* px-1 matches the text row above so the +/send controls left/right-align
              with the placeholder (was px-0.5 → a 2px asymmetry). */}
          <div className="mt-1.5 flex items-center gap-1.5 px-1">
            {/* Left cluster */}
            <button
              type="button"
              aria-label="Add context"
              className="border-stroke-soft-200 text-text-sub-600 hover:bg-bg-weak-50 flex size-9 items-center justify-center rounded-xl border transition-colors"
            >
              <RiAddLine className="size-5" aria-hidden />
            </button>

            {hero && !modelMenu && (
              <button
                type="button"
                aria-label="Tools & agents"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen((o) => !o)}
                className={cn(
                  "flex size-9 items-center justify-center rounded-xl transition-colors",
                  toolsOpen
                    ? "bg-bg-weak-50 text-text-strong-950"
                    : "border-stroke-soft-200 text-text-sub-600 hover:bg-bg-weak-50 border",
                )}
              >
                <RiToolsLine className="size-[18px]" aria-hidden />
              </button>
            )}

            {/* Real chat MODEL picker trigger (honest replacement for the
                placeholder agent picker). Opens the "Choose model" card above. */}
            {modelMenu && (
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={modelMenuOpen}
                aria-label={`Model: ${activeModelOption?.label ?? modelMenu.value}`}
                onClick={() => setModelMenuOpen((o) => !o)}
                className={cn(
                  "flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-label-sm transition-colors",
                  modelMenuOpen
                    ? "border-stroke-soft-200 bg-bg-weak-50 text-text-strong-950"
                    : "border-stroke-soft-200 text-text-sub-600 hover:bg-bg-weak-50",
                )}
              >
                {activeModelOption && (
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: activeModelOption.color }}
                    aria-hidden
                  />
                )}
                <span className="max-w-[10rem] truncate">
                  {activeModelOption?.label ?? "Model"}
                </span>
                <RiArrowDownSLine className="size-4 shrink-0" aria-hidden />
              </button>
            )}

            {/* Right cluster */}
            <div className="ml-auto flex items-center gap-1.5">
              {/* Team-memory pool for the run (org vs personal), sibling to model. */}
              <MemoryScopePicker scope={memoryScope} onChange={setMemoryScope} />
              {/* One engine now — the meaningful per-message choice is the MODEL. */}
              {enableModelPicker && <ModelPicker model={model} onChange={setModel} />}
              {hero && (
                <button
                  type="button"
                  aria-label="Voice input"
                  className="text-text-sub-600 hover:bg-bg-weak-50 flex size-9 items-center justify-center rounded-xl transition-colors"
                >
                  <RiMicLine className="size-5" aria-hidden />
                </button>
              )}
              {running && onStop && !canSend ? (
                // A turn is running and the input is empty: this IS the Stop
                // control (ChatGPT/opencode pattern - Stop where Send lives).
                // Type anything and it flips back to Send so a reply can queue.
                <button
                  type="button"
                  aria-label="Stop this run"
                  title="Stop this run"
                  onClick={onStop}
                  disabled={stopping}
                  className={cn(
                    "flex items-center justify-center rounded-full transition-all",
                    hero ? "size-10" : "size-9",
                    "bg-error-base text-white hover:opacity-90 disabled:opacity-50",
                  )}
                >
                  {stopping ? (
                    <Loader variant="circular" size="sm" className="border-white" />
                  ) : (
                    <RiStopFill className="size-5" aria-hidden />
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="Send"
                  onClick={submit}
                  disabled={!canSend}
                  className={cn(
                    "flex items-center justify-center rounded-full transition-all",
                    hero ? "size-10" : "size-9",
                    canSend
                      ? sendToneClass
                      : "bg-bg-soft-200 text-text-soft-400 cursor-not-allowed",
                  )}
                >
                  {busy ? (
                    <Loader variant="circular" size="sm" className="border-white" />
                  ) : (
                    <RiArrowUpLine className="size-5" aria-hidden />
                  )}
                </button>
              )}
            </div>
          </div>
        </PromptInput>

      </div>
    </div>
  );
}
