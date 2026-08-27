"use client";

import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowUpLine,
  RiErrorWarningLine,
  RiMicLine,
  RiStopFill,
  RiToolsLine,
} from "@remixicon/react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import type { RunResourceSelection } from "@useagent/agent-client/wire";
import { useEffect, useRef, useState } from "react";
import { type Agent, AgentChip, ChooseAgentPopover } from "@/components/chat/agent-command";
import type { CommandCatalogState } from "@/components/chat/canonical-timeline";
import { ChatModelMenu, type ChatModelOption } from "@/components/chat/chat-model-menu";
import { AddFilesRow, AddMenuDivider, CreateRows } from "@/components/chat/composer-add-menu";
import { mentionsToRunResources, useComposerMentions } from "@/components/chat/composer-mentions-ui";
import { ModelPicker } from "@/components/chat/engine-picker";
import { RunUploadChips, useRunUploads } from "@/components/chat/run-uploads";
import {
  type CommandPickerStatus,
  commandOptionId,
  filterCommands,
  parseCommandIntent,
  type SlashCommand,
  SlashCommandPopover,
  slashInsertText,
} from "@/components/chat/slash-command";
import { type EngineId, engineLabel, type MemoryScope } from "@/components/chat/types";
import { Loader } from "@/components/prompt-kit/loader";
import { PromptInput, PromptInputTextarea } from "@/components/prompt-kit/prompt-input";
import { BackgroundStatusPill } from "@/components/session-ui/background-status-pill";
import { ProviderStatusBanner } from "@/components/session-ui/provider-status-banner";
import { ThreadErrorBanner } from "@/components/session-ui/thread-error-banner";
import { cx as cn } from "@/utils/cx";

type Variant = "hero" | "compact";

type ComposerAction =
  | { kind: "send"; label: "Send" }
  | { kind: "steer"; label: "Steer" }
  | { kind: "stop"; label: "Stop this run" };

export function getComposerAction({
  running,
  hasDraft,
  canStop,
}: {
  running: boolean;
  hasDraft: boolean;
  canStop: boolean;
}): ComposerAction {
  if (running && hasDraft) return { kind: "steer", label: "Steer" };
  if (running && canStop) return { kind: "stop", label: "Stop this run" };
  return { kind: "send", label: "Send" };
}

/**
 * Honest default placeholder: hint ONLY affordances this composer actually has.
 * "/" is real (agent picker on hero, command autocomplete when a catalog holds
 * commands); "@" files and "$" skills are NOT typed affordances here today, so
 * they are never advertised. An explicit caller placeholder always wins.
 */
export function composerPlaceholder({
  explicit,
  agentSlash,
  commandCount,
}: {
  explicit?: string;
  agentSlash: boolean;
  commandCount: number;
}): string {
  if (explicit !== undefined) return explicit;
  if (agentSlash) return "Ask anything, / for agents";
  if (commandCount > 0) return "Ask anything, / for commands";
  return "Ask anything...";
}

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
  attachmentIds?: readonly string[],
  resources?: readonly RunResourceSelection[],
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
   *  uses bg-background-primary-default, so it's a clean white pill in light mode and a native dark
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
  /** Allow tenant-scoped files to be uploaded and attached to this sandbox turn. */
  enableUploads?: boolean;
  /** Enable the "@" mention popover (files / pull requests / threads / skills).
   *  Off by default; the in-session reply composer turns it on. */
  enableMentions?: boolean;
  /** Exact repository revisions already bound to this thread. */
  repoRevisions?: Readonly<Record<string, string | null>>;
  onSubmit: ComposerSubmit;
  /** A turn is running in this thread - an empty input exposes Stop, while a
   *  non-empty draft exposes a labelled Steer action for the queued reply. */
  running?: boolean;
  stopping?: boolean;
  /** Visible failure from the durable cancel request; the Stop control remains retryable. */
  stopError?: string | null;
  onStop?: () => void;
  /** ISO start of the RUNNING turn (its run.created_at) - powers the status
   *  pill's elapsed timer; absent shows the pill without elapsed. */
  runStartedAt?: string | null;
  /** The thread's latest-run FAILURE summary (run.summary) - non-null fronts the
   *  banner stack with the T3 error banner. The call site computes visibility
   *  (latest run failed + not session-dismissed, see thread-error-banner helpers)
   *  from thread-store state it already has. */
  threadError?: string | null;
  /** Records the session-scoped dismissal at the call site; absent hides the X. */
  onDismissThreadError?: () => void;
  /** The selected engine is missing from the server's ready-engines manifest
   *  (GET /api/config `engines`, see unavailableEngineLabel) - shows the slim
   *  provider status banner. Computed by the call site; no fetch here. */
  engineUnavailable?: boolean;
  /** Actionable provider/readiness detail from the server manifest. */
  engineUnavailableMessage?: string;
  /** Persist the in-progress draft per thread (localStorage, client only): a
   *  reload or thread switch restores unsent text. Cleared on submit. Absent
   *  keeps the composer stateless (hero/new-task surfaces). */
  draftKey?: string | null;
  /** Externally seed the composer with a ready-to-send message and focus it. The
   *  `nonce` makes each request re-apply even when the text repeats (e.g. a second
   *  "Ask agent to redo"); the text replaces the current draft so the user can send
   *  or edit it. Absent leaves the composer fully user-driven. */
  prefill?: { readonly text: string; readonly nonce: number } | null;
};

/**
 * The useAgent composer — a restyled prompt-kit `PromptInput`. Default `hero`
 * arrangement matches the HeyRico reference (heyrico-clean-design-2): a large
 * rounded card with "Ask anything…", a left cluster (+ · tools) and a right
 * cluster (✳ engine picker · mic · blue circular send).
 * Optional "/" Choose-Agent slash command that renders the selection as a
 * pink inline chip, and a "/" command autocomplete on reply composers.
 *
 * The card surface/border swap via the theme ladder; the blue send and
 * blue accents use the literal blue scale (which doesn't flip), so the anatomy
 * reads identically on the light card and the dark #20201f surface.
 */
export function Composer({
  variant = "hero",
  placeholder,
  engine: engineProp,
  defaultEngine = "opencode",
  pending = false,
  locked = false,
  autoFocus = false,
  className,
  enableAgentCommand,
  enableModelPicker = true,
  modelMenu,
  defaultModel = "claude-opus-5",
  defaultMemoryScope = "org",
  commands,
  commandState,
  enableUploads = false,
  enableMentions = false,
  repoRevisions,
  onSubmit,
  running = false,
  stopping = false,
  stopError,
  onStop,
  runStartedAt,
  threadError,
  onDismissThreadError,
  engineUnavailable = false,
  engineUnavailableMessage,
  draftKey,
  prefill,
}: ComposerProps) {
  // Draft restore is a lazy initializer so SSR (no window) and draft-less
  // composers stay on the empty string with zero effect churn.
  const [value, setValue] = useState(() => {
    if (!draftKey || typeof window === "undefined") return "";
    return window.localStorage.getItem(`useagent.draft.${draftKey}`) ?? "";
  });
  useEffect(() => {
    if (!draftKey || typeof window === "undefined") return;
    const key = `useagent.draft.${draftKey}`;
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  }, [draftKey, value]);
  // External prefill (e.g. "Ask agent to redo" on a conflicted proposal): apply
  // once per nonce so a repeat request still lands, replacing the draft and moving
  // focus + caret to the end so the message is one keystroke from sending.
  const rootRef = useRef<HTMLDivElement>(null);
  const appliedPrefillNonce = useRef(0);
  useEffect(() => {
    if (!prefill || prefill.nonce === appliedPrefillNonce.current) return;
    appliedPrefillNonce.current = prefill.nonce;
    setValue(prefill.text);
    const textarea = rootRef.current?.querySelector("textarea");
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(prefill.text.length, prefill.text.length);
    }
  }, [prefill]);
  // Single fixed engine here; there is no setter (this composer serves replies -
  // a thread is pinned to one engine - and the no-sandbox Chat surface). Engine
  // SELECTION for a new task lives in NewTaskComposer. Kept as state so `engineProp`
  // can still override it without changing the call sites.
  const [engineState] = useState<EngineId>(defaultEngine);
  const [model, setModel] = useState(defaultModel);
  const [command, setCommand] = useState<Agent | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // The "+" add-context menu (compact reply composer): a popover above the input
  // holding the real upload row + the Create prompt-seeds, shared with the
  // new-thread shelf. Only mounted when uploads are enabled (the reply composer).
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [cmdHighlight, setCmdHighlight] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  // Prompt-submission transaction: `submitting` guards the in-flight await (no
  // duplicate submit); `failed` surfaces an explicit retry state; `retry` holds
  // the draft + its idempotency key so a resend of the same text reuses the key.
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const retry = useRef<{ text: string; key: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const runUploads = useRunUploads();
  // The "@" mention popover + chips (files / pull requests / threads / skills).
  const mentions = useComposerMentions({
    value,
    onValueChange: setValue,
    containerRef: rootRef,
    enabled: enableMentions,
    selectedRepos: repoRevisions ? Object.keys(repoRevisions) : undefined,
    repoRevisions,
  });

  const engine = engineProp ?? engineState;
  const hero = variant === "hero";
  // The real chat model picker (honest options) supersedes the placeholder agent
  // picker on this composer when supplied.
  const activeModelOption = modelMenu?.options.find((o) => o.value === modelMenu.value);
  const allowAgent = enableAgentCommand ?? hero;
  const slashActive = allowAgent && !command && value.trimStart().startsWith("/");
  const showAgentPopover = slashActive || toolsOpen;
  const busy = pending || submitting;
  const blocked = busy || locked || runUploads.blocked;
  const hasDraft = value.trim().length > 0;
  const canSend = hasDraft && !blocked;
  const composerAction = getComposerAction({
    running,
    hasDraft,
    canStop: Boolean(onStop),
  });
  const actionBusy = composerAction.kind === "stop" ? stopping : busy;
  const actionDisabled = composerAction.kind === "stop" ? stopping : !canSend;
  const actionLabel = composerAction.kind === "steer" ? "Steer this run" : composerAction.label;

  // Slash-command autocomplete: live while the FIRST token is being typed
  // ("/rev" but not "/review changes"). A trailing space ends completion.
  // The honest command-catalog state (Phase 7) supersedes the plain `commands` prop when present:
  // its READY catalog is the source of options, and its status drives the loading/unavailable/
  // error rows so the picker is always truthful instead of "just nothing".
  const catalogStatus: CommandPickerStatus = commandState?.status ?? "ready";
  const catalogSource =
    commandState?.status === "unavailable" || commandState?.status === "ready"
      ? commandState.source
      : undefined;
  const catalogCommands: SlashCommand[] = commandState
    ? commandState.status === "ready"
      ? commandState.commands.map((c) => ({
          name: c.name,
          description: c.description ?? null,
          input: c.input ?? null,
        }))
      : []
    : (commands ?? []);
  // Honest affordance hint: only when the caller didn't set a placeholder, and
  // only for the "/" affordances that really exist on THIS composer instance.
  const effectivePlaceholder = composerPlaceholder({
    explicit: placeholder,
    agentSlash: allowAgent,
    commandCount: catalogCommands.length,
  });
  const cmdToken = /^\/([^\s]*)$/.exec(value.trimStart())?.[1];
  const slashTyped = !allowAgent && !cmdDismissed && cmdToken !== undefined;
  const cmdMatches = slashTyped ? filterCommands(catalogCommands, cmdToken ?? "") : [];
  // Show the popover while typing "/" when there is SOMETHING honest to show: matches, a
  // non-ready state row (loading/unavailable/error), or a ready-but-no-match note when a catalog
  // exists. A ready+empty catalog (the engine advertises none) shows nothing.
  const cmdActive =
    slashTyped &&
    (cmdMatches.length > 0 || catalogStatus !== "ready" || catalogCommands.length > 0);
  const cmdHighlightedName =
    cmdMatches.length > 0
      ? cmdMatches[Math.min(cmdHighlight, cmdMatches.length - 1)]?.name
      : undefined;

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
      retry.current && retry.current.text === text ? retry.current.key : crypto.randomUUID();
    setSubmitting(true);
    setFailed(false);
    setFailureMessage(null);
    setValue(""); // optimistic clear — the pending bubble shows the text meanwhile
    try {
      // A typed native-command intent when the text is a `/known-command ...` for THIS
      // composer's catalog; else null (an ordinary prompt). Parse from the RAW value (not the
      // trimmed text) so a command's argument bytes reach the backend EXACTLY as typed - the
      // backend rebuilds `/name <args>` verbatim from this intent. The backend re-validates.
      const intent = commands ? parseCommandIntent(raw, commands) : null;
      // The chat model picker (when present) owns the model; else the internal state.
      await onSubmit(
        text,
        engine,
        modelMenu?.value ?? model,
        key,
        // Memory scope is inherited from the thread (the interactive picker was
        // removed from the toolbar); the run still reads/writes that pool.
        defaultMemoryScope,
        intent,
        runUploads.readyIds,
        mentionsToRunResources(mentions.mentions),
      );
      retry.current = null; // accepted — drop the retry key
      runUploads.clearAccepted();
      mentions.clear(); // accepted — drop the chips (their text tokens already sent)
    } catch (error) {
      // Never silently swallow: restore the draft and show an explicit failed
      // state; keep the key so the next send retries idempotently.
      retry.current = { text, key };
      setValue(text);
      setFailed(true);
      setFailureMessage(error instanceof Error ? error.message : null);
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
    // The composer THEME-FOLLOWS: its card uses bg-background-primary-default (white in light mode,
    // #20201f in dark) so it reads as the reference's clean white pill in light and
    // a native dark pill in dark - never a white island clashing with the dark page.
    <div ref={rootRef} className={cn("relative w-full", className)}>
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

      {/* The "@" mention popover (files / pull requests / threads / skills). It
          carries its own absolute placement (above this reply composer). */}
      {mentions.popover}

      {/* The "+" add-context menu: a BoardUI-style popover ABOVE the input (the
          reply composer sits at the viewport bottom). Same rows as the new-thread
          shelf via the shared module - a real upload + Create prompt-seeds. Repos
          and GitHub are omitted here: a reply reuses the thread's provisioned
          sandbox, so they are not real reply capabilities. */}
      {enableUploads && (
        <AnimatePresence>
          {addMenuOpen && (
            <>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                className="fixed inset-0 z-20 cursor-default"
                onClick={() => setAddMenuOpen(false)}
              />
              <div className="absolute bottom-full left-0 z-30 mb-2 w-full">
                <motion.div
                  role="menu"
                  aria-label="Add context"
                  initial={{ opacity: 0, scale: 0.96, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: 4 }}
                  transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                  className="w-[300px] max-w-full origin-bottom-left rounded-2xl border border-border-button-default bg-background-primary-default p-1.5 shadow-dropdown"
                >
                  <AddFilesRow
                    onPick={() => {
                      setAddMenuOpen(false);
                      fileInput.current?.click();
                    }}
                  />
                  <AddMenuDivider />
                  <CreateRows
                    onSeed={(seed) => {
                      setAddMenuOpen(false);
                      setValue((prev) => (prev.trim() ? prev : seed));
                    }}
                  />
                </motion.div>
              </div>
            </>
          )}
        </AnimatePresence>
      )}

      {failed && (
        <div
          role="alert"
          className="text-red-500 mb-1.5 flex items-center gap-1.5 px-1 text-caption-1-regular"
        >
          <RiErrorWarningLine className="size-3.5 shrink-0" aria-hidden />
          {failureMessage ?? "Couldn't send - your message is restored. Press send to try again."}
        </div>
      )}

      {stopError && (
        <div
          role="alert"
          data-testid="stop-error"
          className="text-red-500 mb-1.5 flex items-center gap-1.5 px-1 text-caption-1-regular"
        >
          <RiErrorWarningLine className="size-3.5 shrink-0" aria-hidden />
          Couldn&apos;t stop this run: {stopError}. Try again.
        </div>
      )}

      {/* T3 banner stack above the input card, ordered error -> provider ->
          live-status. Every banner's state is computed by the call site (no
          fetches here). The status pill keeps the persistent Stop reachable
          even while a Steer draft is being typed (the send button is Steer
          then, not Stop) - same existing durable cancel handler as the button,
          never a second API path. */}
      {(threadError || engineUnavailable || (running && onStop)) && (
        <div className="mb-1.5 flex flex-col gap-1.5">
          {threadError && (
            <ThreadErrorBanner error={threadError} onDismiss={onDismissThreadError} />
          )}
          {engineUnavailable && (
            <ProviderStatusBanner
              engineLabel={engineLabel(engine)}
              description={engineUnavailableMessage}
            />
          )}
          {running && onStop && (
            <BackgroundStatusPill
              label="Run in progress"
              startedAt={runStartedAt}
              onStop={onStop}
              stopping={stopping}
            />
          )}
        </div>
      )}

      {/* No overflow-hidden here: the engine-picker popover opens upward past
          the card edge and must not be clipped. */}
      <div
        className={cn(
          "border-border-button-default bg-background-primary-default border",
          hero ? "rounded-3xl shadow-md" : "rounded-[20px]",
        )}
      >
        {enableUploads ? (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files) void runUploads.addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <RunUploadChips
              uploads={runUploads.uploads}
              onRemove={(upload) => void runUploads.remove(upload)}
            />
          </>
        ) : null}
        {/* Structured "@" mentions render as removable chips above the input. */}
        {mentions.chips}
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
          maxHeight={180}
          className={cn(
            "cursor-text rounded-none border-0 bg-transparent shadow-none",
            hero
              ? "p-3 md:p-4"
              : "grid h-fit grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 p-2",
          )}
        >
          <div
            className={cn(
              "flex items-start gap-1.5 px-1",
              !hero && "col-start-2 row-start-1 min-w-0 items-center",
            )}
          >
            {command && (
              <span className="pt-1">
                <AgentChip agent={command} onRemove={() => setCommand(null)} />
              </span>
            )}
            <PromptInputTextarea
              autoFocus={autoFocus}
              disabled={locked}
              placeholder={command ? "" : effectivePlaceholder}
              // ARIA combobox/listbox wiring for the "/" command popover: announce that a list is
              // available, whether it is open, and which option is active (so a screen reader reads
              // the highlighted command as the user arrows through it).
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={cmdActive}
              aria-controls={cmdActive ? "slashcmd-label" : undefined}
              aria-activedescendant={
                cmdActive && cmdHighlightedName ? commandOptionId(cmdHighlightedName) : undefined
              }
              onSelect={mentions.onTextareaSelect}
              onKeyDown={(e) => {
                mentions.onTextareaKeyDown(e); // "@" popover claims arrows/Enter/Esc first
                if (e.defaultPrevented) return;
                handleCmdKeys(e);
                if (e.key === "Backspace" && value === "" && command) {
                  setCommand(null);
                }
              }}
              className={cn(
                "flex-1",
                // Compact: the box height must equal the line-height so the single
                // line of placeholder/text sits vertically CENTERED against the
                // +/send buttons - a taller min-height top-aligns the text (textarea
                // text can't vertical-center), which read as "input slightly up". It
                // still auto-grows with content up to maxHeight.
                hero ? "pt-1 text-headline-regular" : "min-h-6 text-body-2-regular leading-6",
              )}
            />
          </div>

          {/* px-1 matches the text row above so the +/send controls left/right-align
              with the placeholder (was px-0.5 → a 2px asymmetry). */}
          <div className={cn(hero ? "mt-1 flex items-center gap-1.5 px-1" : "contents")}>
            {/* Left cluster */}
            {enableUploads ? (
              <button
                type="button"
                aria-label="Add context"
                aria-haspopup="menu"
                aria-expanded={addMenuOpen}
                onClick={() => setAddMenuOpen((o) => !o)}
                className={cn(
                  "col-start-1 row-start-1 flex size-9 items-center justify-center rounded-full border transition-colors",
                  addMenuOpen
                    ? "border-border-button-default bg-background-secondary-default text-text-primary"
                    : "border-border-button-default text-text-secondary hover:bg-background-primary-hover",
                )}
              >
                <RiAddLine
                  className={cn(
                    "size-5 transition-transform duration-200",
                    addMenuOpen && "rotate-45",
                  )}
                  aria-hidden
                />
              </button>
            ) : null}

            {hero && !modelMenu && (
              <button
                type="button"
                aria-label="Tools & agents"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen((o) => !o)}
                className={cn(
                  "flex size-9 items-center justify-center rounded-xl transition-colors",
                  toolsOpen
                    ? "bg-background-secondary-default text-text-primary"
                    : "border-border-button-default text-text-secondary hover:bg-background-primary-hover border",
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
                  "flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-body-2-medium transition-colors",
                  modelMenuOpen
                    ? "border-border-button-default bg-background-secondary-default text-text-primary"
                    : "border-border-button-default text-text-secondary hover:bg-background-primary-hover",
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
            <div
              className={cn(
                "ml-auto flex items-center gap-1.5",
                !hero && "col-start-3 row-start-1",
              )}
            >
              {/* One engine now — the meaningful per-message choice is the MODEL. */}
              {enableModelPicker && (
                <ModelPicker engine={engine} model={model} onChange={setModel} />
              )}
              {hero && (
                <button
                  type="button"
                  aria-label="Voice input"
                  className="text-text-secondary hover:bg-background-primary-hover flex size-9 items-center justify-center rounded-xl transition-colors"
                >
                  <RiMicLine className="size-5" aria-hidden />
                </button>
              )}
              <MotionConfig reducedMotion="user">
                <motion.button
                  layout
                  type="button"
                  aria-label={actionLabel}
                  title={composerAction.kind === "send" ? undefined : actionLabel}
                  onClick={composerAction.kind === "stop" ? onStop : submit}
                  disabled={actionDisabled}
                  transition={{
                    layout: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
                  }}
                  className={cn(
                    "flex shrink-0 items-center justify-center overflow-hidden rounded-full transition-colors",
                    hero ? "h-10 min-w-10" : "h-9 min-w-9",
                    composerAction.kind === "steer" ? "gap-1.5 px-3.5" : hero ? "w-10" : "w-9",
                    composerAction.kind === "stop"
                      ? "bg-red-500 text-white hover:opacity-90 disabled:opacity-50"
                      : canSend
                        ? "bg-accent-500 text-white hover:bg-accent-600"
                        : "bg-background-tertiary-default text-text-tertiary cursor-not-allowed",
                  )}
                >
                  <AnimatePresence initial={false} mode="popLayout">
                    <motion.span
                      key={`${composerAction.kind}-${actionBusy ? "busy" : "ready"}`}
                      initial={{ opacity: 0, filter: "blur(4px)", scale: 0.96 }}
                      animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                      exit={{ opacity: 0, filter: "blur(4px)", scale: 0.96 }}
                      transition={{ duration: 0.16, ease: "easeOut" }}
                      className="flex items-center justify-center gap-1.5 whitespace-nowrap"
                    >
                      {actionBusy ? (
                        <Loader variant="circular" size="sm" className="border-white" />
                      ) : composerAction.kind === "stop" ? (
                        <RiStopFill className="size-5" aria-hidden />
                      ) : (
                        <>
                          <RiArrowUpLine className="size-5" aria-hidden />
                          {composerAction.kind === "steer" ? (
                            <span className="text-body-2-medium">{composerAction.label}</span>
                          ) : null}
                        </>
                      )}
                    </motion.span>
                  </AnimatePresence>
                </motion.button>
              </MotionConfig>
            </div>
          </div>
        </PromptInput>
      </div>
    </div>
  );
}
