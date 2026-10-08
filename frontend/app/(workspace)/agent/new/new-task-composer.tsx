"use client";

import { desktopBridge, localRunnerAvailable, type UseAgentDesktopBridge } from "@/components/runners/desktop-bridge";
import { useMachineRunsWork } from "@/components/runners/local-login-availability";
import { type RunLocation, RunLocationMenu, submittedRunLocation } from "@/components/runners/run-location-menu";
import { RiArrowUpLine, RiBookMarkedLine, RiFlashlightLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AddFilesRow,
  AddMenuDivider,
  CreateRows,
  GithubConnectedRow,
} from "@/components/chat/composer-add-menu";
import { mentionsToRunResources, useComposerMentions } from "@/components/chat/composer-mentions-ui";
import { engineProvider } from "@/components/chat/catalog-model-picker";
import {
  engineRuntimeCaption,
  pickerEngineOptions,
  resolveEnabledEngine,
  useEnabledEngineConfig,
} from "@/components/chat/engine-picker";
import { attachmentIntake, useRunUploads } from "@/components/chat/run-uploads";
import {
  type CommandPickerStatus,
  filterCommands,
  type SlashCommand,
  SlashCommandPopover,
  slashInsertText,
} from "@/components/chat/slash-command";
import {
  type EngineId,
  engineLabel,
  isFreeModel,
  modelOptionsForEngine,
  type PermissionMode,
} from "@/components/chat/types";
import { permissionModeFor } from "@/components/chat/permission-mode";
import { PermissionModeChip } from "@/components/pro/permission-mode-chip";
import { AgentThinking } from "@/components/application/agent-thinking/agent-thinking";
import { ComposerLoader } from "@/components/application/composer-loader/composer-loader";
import { Button } from "@/components/base/buttons/button";
import { ComposerAttachmentRow } from "@/components/pro/composer-attachments";
import { ComposerAddButton } from "@/components/pro/composer-panel/composer-panel";
import { ModelPicker } from "@/components/pro/model-picker";
import { PromptInput, PromptInputTextarea } from "@/components/prompt-kit/prompt-input";
import { backendFetch } from "@/lib/backend-fetch";
import { loadRepoList } from "@/lib/repo-list";
import {
  createRun,
  runCreateFailureMessage,
  type RunCreateAttempt,
  selectRunCreateAttempt,
} from "@/lib/create-run";
import { cx } from "@/utils/cx";
import { RepoBranchBar } from "./repo-branch-bar";
import { type RepoItem, RepoMultiPicker } from "./repo-multi-picker";
import { type PickerGroup, SearchablePicker } from "./searchable-picker";
import type { Skill } from "./skills-data";
import {
  AddProviderKey,
  keyRequiredError,
  START_FREE_ERROR,
  StartFreePrompt,
  startFreeModel,
  startFreeVisible,
  useStartFree,
} from "./start-free-prompt";
import { mentionedBotIds } from "@/components/chat/composer-mentions";

/**
 * The New Task composer: a prompt textarea over a control row of searchable
 * pickers (repo / playbook / engine / model), a secondary row of per-repo branch
 * pickers, and the "Start agent" CTA. Client-side because it owns every
 * selection, the prompt, and the POST → redirect.
 *
 * Every control here reaches the backend: the prompt, engine, model (when the
 * engine exposes a curated catalog), selected repos, per-repo branches, memory
 * scope and the pinned skill all ride into POST /api/runs; on success it routes
 * to the run's /session view.
 */
export function NewTaskComposer({
  skills,
  initialRepository = null,
  initialPrompt = "",
}: {
  skills: Skill[];
  initialRepository?: string | null;
  initialPrompt?: string;
}) {
  const router = useRouter();

  const [prompt, setPrompt] = useState(initialPrompt);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [playbook, setPlaybook] = useState(""); // selected skill/playbook id, "" = none
  // A new thread starts in Full access unless the person picks a mode before sending.
  const [chosenMode, setChosenMode] = useState<PermissionMode>("full-access");
  // Where the thread runs: the desktop app's Local/Cloud menu sets it (Local
  // while this machine's runner is connected); the web app has no menu, sends
  // nothing and runs on the cloud. A machine login counts only on the machine.
  const [bridge, setBridge] = useState<UseAgentDesktopBridge | null>(null);
  useEffect(() => setBridge(desktopBridge()), []);
  const [runLocation, setRunLocation] = useState<RunLocation | null>(null);
  const onMachine = runLocation === "local";
  // Codex is the preferred default engine. Model membership and the default
  // arrive from the authenticated capability catalog below.
  const [model, setModel] = useState("");
  // A reasoning level from the picker; null runs on the runtime's default.
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [engine, setEngine] = useState<string>("codex");
  // What actually rides POST /api/runs: the pick, unless the selected engine
  // cannot honour it (admission would refuse the run), then Full access.
  const permissionMode = permissionModeFor(engine, chosenMode);
  // The "+" action shelf under the composer holds the add-context controls
  // (upload, repos, skills, GitHub, branches) so the toolbar row never overflows.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Only offer engines the SERVER configured (GET /api/capabilities, gated by
  // ENABLED_ENGINES): claude/codex surface here only on a backend that turned them
  // on, so the picker never lets a user start a run the backend would 403. This is
  // the capability-driven engine manifest.
  const engineConfig = useEnabledEngineConfig({ machineLogins: onMachine });
  const machineRunsWork = useMachineRunsWork() && onMachine;
  const enabledEngines = engineConfig.engines;
  const engineId = engine as EngineId;
  const selectableModels = modelOptionsForEngine(
    engineId,
    engineConfig.models[engineId] ?? [],
    engineConfig.modelDetails[engineId] ?? [],
  );
  // The Free lane tracks OpenRouter's live catalog; the heading's refresh
  // re-derives it on demand (same affordance as the chat surface's picker).
  const [refreshingModels, setRefreshingModels] = useState(false);
  const { refreshModels } = engineConfig;
  // What the member's keys can run: the start-free card, the picker's "Needs
  // key" rows and Free action, the free fallback and the send check below. A
  // machine thread runs on the machine's logins, so nothing needs a key there.
  const startFree = useStartFree();
  const keyAccess = onMachine ? null : startFree.access;
  const lockedBy =
    keyAccess?.missing(engineId, engineConfig.modelDetails[engineId]?.find((entry) => entry.id === model)?.provider) ?? null;
  const runnableFree = (engineConfig.modelDetails.opencode ?? [])
    .filter((entry) => entry.dispatchable && isFreeModel(entry.id) && !keyAccess?.missing("opencode", entry.provider))
    .map((entry) => entry.id);
  const modelPicked = useRef(false);
  const freeModel =
    engineConfig.loaded && !onMachine ? startFreeModel(startFree, runnableFree, lockedBy !== null) : null;
  useEffect(() => {
    // A model picked here stays unless it needs a key the member lacks.
    if (!freeModel || (modelPicked.current && !lockedBy)) return;
    setEngine("opencode");
    setModel(freeModel);
  }, [freeModel, lockedBy]);
  const refreshFreeModels = useCallback(
    async (preserveModel: string, target: EngineId) => {
      setRefreshingModels(true);
      try {
        await refreshModels(preserveModel, target);
      } finally {
        setRefreshingModels(false);
      }
    },
    [refreshModels],
  );
  // The rail: one entry per engine the server configured, each with its manifest
  // lineup. Readiness decorates an engine's title instead of hiding it.
  const providers = useMemo(
    () =>
      pickerEngineOptions(enabledEngines).map((candidate) =>
        engineProvider(
          candidate.id,
          engineConfig,
          // Bound to the entry's own engine: browsing OpenCode's Free lane from a
          // Codex selection refreshes the Free lane, not the Codex catalog.
          { refreshing: refreshingModels, onRefresh: () => void refreshFreeModels(model, candidate.id) },
          engineRuntimeCaption(
            candidate.id,
            engineConfig.runtimes[candidate.id],
            engineConfig.readiness[candidate.id],
            engineConfig.localLoginOffered.includes(candidate.id),
            machineRunsWork,
          ),
          keyAccess,
        ),
      ),
    [enabledEngines, engineConfig, keyAccess, machineRunsWork, model, refreshFreeModels, refreshingModels],
  );
  // Per-repo branch overrides (repo full_name -> branch). An absent entry means
  // "clone the repo's default branch"; only overrides are sent to the backend.
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const runCreateAttempt = useRef<RunCreateAttempt | null>(null);
  const runUploads = useRunUploads();

  // The "@" mention popover: this composer already knows the org's repos + the
  // skill catalog, so it seeds the file picker (selected repos first) and the
  // skill list rather than refetching. It opens BELOW the composer (top of page).
  const mentionSkills = useMemo(
    () => skills.map((s) => ({ id: s.id, name: s.name, tag: s.tags[0] })),
    [skills],
  );
  const mentions = useComposerMentions({
    value: prompt,
    onValueChange: setPrompt,
    containerRef: composerRef,
    skills: mentionSkills,
    selectedRepos,
    repoRevisions: Object.fromEntries(
      repos.map((repo) => [repo.full_name, branches[repo.full_name] ?? repo.default_branch]),
    ),
    placement: "bottom",
  });

  useEffect(() => {
    if (!engineConfig.loaded) return;
    const resolved = resolveEnabledEngine(engineId, enabledEngines);
    if (resolved && resolved !== engineId) setEngine(resolved);
  }, [enabledEngines, engineConfig.loaded, engineId]);

  // Slash-command autocomplete for the "/" first token. ENGINE-AWARE: the catalog is the
  // SELECTED engine's real command list, cached server-side (GET /api/commands?engine=) so it
  // is available BEFORE any sandbox exists - opencode's snapshot catalog, or the org-scoped
  // Claude/Codex native catalog. Refetches when the engine changes. Selection only completes
  // the text; the command executes engine-side (verbatim `/name`) once the run starts.
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [commandStatus, setCommandStatus] = useState<CommandPickerStatus>("loading");
  const [cmdHighlight, setCmdHighlight] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCommands([]); // clear the prior engine's catalog while the new one loads (no stale mix)
    setCommandStatus("loading");
    void (async () => {
      try {
        const res = await backendFetch(`/api/commands?engine=${encodeURIComponent(engine)}`);
        if (!res.ok) {
          if (!cancelled) setCommandStatus("error");
          return;
        }
        const data = (await res.json()) as {
          commands?: { name?: string; description?: string | null }[];
        };
        if (cancelled || !Array.isArray(data.commands)) return;
        const nextCommands = data.commands
            .filter((c): c is { name: string; description?: string | null } => !!c.name)
            .map((c) => ({ name: c.name, description: c.description ?? null }));
        setCommands(nextCommands);
        setCommandStatus(nextCommands.length > 0 ? "ready" : "unavailable");
      } catch {
        if (!cancelled) setCommandStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine]);

  useLayoutEffect(() => {
    if (selectableModels.length === 0) return;
    if (!selectableModels.some((m) => m.value === model)) {
      setModel(selectableModels[0]?.value ?? "");
    }
  }, [model, selectableModels]);

  // Real repositories for the multi-select repo picker: the page's shared list
  // (GET /api/repos once per page, the backend-held GitHub token stays server-side).
  // Empty when unconfigured, so the picker just shows "No repositories available".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const repos = await loadRepoList();
        if (cancelled) return;
        const offeredRepos = repos.map((r) => ({
          full_name: r.full_name,
          name: r.name ?? r.full_name,
          private: r.private,
          default_branch: r.default_branch ?? "main",
        }));
        setRepos(offeredRepos);
        if (
          initialRepository &&
          offeredRepos.some((repo) => repo.full_name === initialRepository)
        ) {
          setSelectedRepos([initialRepository]);
        }
      } catch {
        // no repos configured — the picker shows nothing to select
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialRepository]);

  // Live while the FIRST token is being typed ("/rev" but not "/review x"); a
  // trailing space ends completion. Mirrors composer.tsx exactly.
  const cmdToken = /^\/([^\s]*)$/.exec(prompt.trimStart())?.[1];
  const cmdMatches =
    !cmdDismissed && commands.length > 0 && cmdToken !== undefined
      ? filterCommands(commands, cmdToken)
      : [];
  const slashTyped = !cmdDismissed && cmdToken !== undefined;
  const cmdActive = slashTyped &&
    (cmdMatches.length > 0 || commandStatus !== "ready" || commands.length > 0);

  function pickCommand(cmd: SlashCommand) {
    setPrompt(slashInsertText(cmd.name)); // verbatim `/name ` - executes engine-side as-is
    setCmdHighlight(0);
  }

  /** Arrow/Enter/Tab/Esc drive the popover while it is open; returns true when
   *  the key was consumed so the caller skips its own Enter-submits path. */
  function handleCmdKeys(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!cmdActive) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      setCmdDismissed(true);
      return true;
    }
    if (cmdMatches.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCmdHighlight((h) => (h + 1) % cmdMatches.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCmdHighlight((h) => (h - 1 + cmdMatches.length) % cmdMatches.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pickCommand(cmdMatches[Math.min(cmdHighlight, cmdMatches.length - 1)]);
      return true;
    }
    return false;
  }
  // Deep-link preselect: the Skills and Playbooks pages' "Run" buttons route here
  // with ?skill=<id> (any kind), so the picker opens with it already chosen.
  useEffect(() => {
    const preskill = new URLSearchParams(window.location.search).get("skill");
    if (preskill && skills.some((s) => s.id === preskill)) setPlaybook(preskill);
  }, [skills]);

  // One combined picker over the shared substrate: an explicit "none" option, then
  // Skills and Playbooks as separate groups (a run pins exactly one, either kind).
  const skillGroups: PickerGroup[] = useMemo(() => {
    const toOption = (s: Skill) => ({
      value: s.id,
      label: s.name,
      caption: s.tags[0],
      icon: s.kind === "playbook" ? RiBookMarkedLine : RiFlashlightLine,
    });
    const skillOptions = skills.filter((s) => s.kind === "skill").map(toOption);
    const playbookOptions = skills.filter((s) => s.kind === "playbook").map(toOption);
    const groups: PickerGroup[] = [{ options: [{ value: "", label: "Playbook or skills" }] }];
    if (skillOptions.length > 0) groups.push({ label: "Skills", options: skillOptions });
    if (playbookOptions.length > 0) groups.push({ label: "Playbooks", options: playbookOptions });
    return groups;
  }, [skills]);

  // The selected repos (with their default_branch) drive the per-repo branch strip.
  const selectedRepoItems = useMemo(
    () => repos.filter((r) => selectedRepos.includes(r.full_name)),
    [repos, selectedRepos],
  );

  async function submit() {
    const text = prompt.trim();
    if (!text) return;
    const readiness = engineConfig.readiness[engineId];
    if (
      readiness &&
      !readiness.ready &&
      !engineConfig.localLoginOffered.includes(engineId)
    ) {
      setError(readiness.message ?? `${engineLabel(engineId)} is not ready. Check Settings and retry.`);
      return;
    }
    const keyError = onMachine
      ? null
      : startFree.needsKey
        ? START_FREE_ERROR
        : lockedBy
          ? keyRequiredError(lockedBy)
          : null;
    if (keyError) {
      setError(keyError);
      return;
    }
    setSubmitting(true);
    setError(null);
    // Close the add-context shelf so the rim light wraps the full rounded card
    // (the shelf's controls are inert during submission anyway).
    setAddMenuOpen(false);

    // Skill/playbook selection is a REAL run contract now — send { id, version }
    // so the backend pins the immutable revision and injects its SKILL.md as
    // engine instructions. The user's prompt stays CLEAN (no name decoration).
    // A skill "@" mention binds here too: the explicit picker wins, else the first
    // skill mention pins the run (reusing the same wire field, no new one).
    const firstSkillMention = mentions.mentions.find((m) => m.kind === "skill");
    const selectedSkill =
      skills.find((s) => s.id === playbook) ??
      (firstSkillMention ? skills.find((s) => s.id === firstSkillMention.id) : undefined);

    // Per-repo branch overrides: only send entries for SELECTED repos whose
    // chosen branch differs from the repo's default (a bare repo = default
    // branch on the backend), so the payload stays minimal and honest.
    const branchPayload: Record<string, string> = {};
    for (const item of selectedRepoItems) {
      const chosen = branches[item.full_name];
      if (chosen && chosen !== item.default_branch) branchPayload[item.full_name] = chosen;
    }
    const mentionResources = mentionsToRunResources(mentions.mentions);
    const mentionedBots = mentionedBotIds(mentions.mentions);

    // Pinned at the first submission: an unmade choice becomes the Cloud the
    // menu shows, so a retry of a lost response carries the same body and key.
    const location = submittedRunLocation(runLocation, bridge !== null && localRunnerAvailable(bridge.platform));
    if (location !== runLocation) setRunLocation(location);
    const body = {
      // Send a model only for engines with an explicit picker/catalog. Codex
      // uses bare backend-policy ids; OpenCode uses provider-qualified ids.
      prompt: text,
      engine,
      memory_scope: "org",
      permission_mode: permissionMode,
      ...(location ? { run_location: location } : {}),
      ...(selectableModels.length > 0 ? { model } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(selectedRepos.length ? { repos: selectedRepos } : {}),
      ...(Object.keys(branchPayload).length ? { branches: branchPayload } : {}),
      ...(mentionResources.length ? { resources: mentionResources } : {}),
      ...(mentionedBots.length ? { bot_mentions: mentionedBots } : {}),
      ...(runUploads.readyIds.length > 0 ? { attachments: runUploads.readyIds } : {}),
      ...(selectedSkill
        ? { skill: { id: selectedSkill.id, version: selectedSkill.version } }
        : {}),
    };
    const attempt = selectRunCreateAttempt(body, runCreateAttempt.current);
    runCreateAttempt.current = attempt;

    try {
      const res = await createRun(body, attempt.idempotencyKey);
      if (!res.ok) {
        setError(await runCreateFailureMessage(res));
        setSubmitting(false);
        return;
      }
      const data = (await res.json()) as { id?: string };
      if (!data.id) throw new Error("missing run id");
      runCreateAttempt.current = null;
      router.push(`/session/${data.id}`);
      // Keep `submitting` true through the navigation.
    } catch {
      setError("Couldn't start the thread. Check the backend and try again.");
      setSubmitting(false);
    }
  }

  // The key a send refusal offers to add, read off the refusal itself.
  const errorKey =
    error === START_FREE_ERROR ? "openrouter" : lockedBy && error === keyRequiredError(lockedBy) ? lockedBy : null;

  return (
    <div>
      {!onMachine &&
      startFreeVisible(
        startFree.needsKey || (lockedBy !== null && !freeModel && startFree.openRouterMissing),
        startFree.dismissed,
        startFree.formProvider,
      ) ? (
        <StartFreePrompt
          formProvider={startFree.formProvider}
          connection={startFree.formConnection}
          onAdd={() => startFree.openForm("openrouter")}
          onDismiss={startFree.dismiss}
          onSaved={async () => {
            await startFree.saved();
            setError(null);
          }}
        />
      ) : null}
      {/* Composer card modeled on the ai-kit KnowledgeComposerCard: an outer card
          wrapping a darker inset that holds the prompt textarea and a clean pill
          toolbar. Every control is real - attach, repos, engine, model, skill -
          and rides POST /api/runs on submit.

          While the run is being created (click -> navigation) the ComposerLoader
          rim light carries the working state: it paints the card surface itself,
          so the PromptInput goes transparent (bg/border/shadow) for that window
          and hands the surface back when idle. Geometry is untouched. */}
      <ComposerLoader active={submitting} radius={20} className="relative z-10">
        <PromptInput
          value={prompt}
          onValueChange={(value) => {
            setPrompt(value);
            setCmdDismissed(false);
            setCmdHighlight(0);
          }}
          onSubmit={() => void submit()}
          maxHeight={260}
          disabled={submitting}
          className={cx(
            // Idle and focused, the composer keeps the same border as the rest
            // of the UI chrome (no focus ring, no lifted border). While
            // submitting, the ComposerLoader rim light is the animated gradient
            // ring, so the card surface goes transparent.
            "rounded-20 p-2 shadow-card transition-colors",
            submitting && "border-transparent bg-transparent opacity-100 shadow-none",
          )}
        >
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
          {/* Files dropped on the card or pasted into the field become attachments. */}
          <div className="relative" ref={composerRef} {...attachmentIntake(runUploads.addFiles, !submitting)}>
            {cmdActive && (
              <div className="absolute left-0 top-full z-30 mt-2 w-full">
                <SlashCommandPopover
                  matches={cmdMatches}
                  highlight={Math.max(0, Math.min(cmdHighlight, cmdMatches.length - 1))}
                  onSelect={pickCommand}
                  status={commandStatus}
                  source={engine}
                />
              </div>
            )}
            {/* The "@" mention popover carries its own placement (below the composer). */}
            {mentions.popover}
            <ComposerAttachmentRow
              uploads={runUploads.uploads}
              onRemove={(upload) => void runUploads.remove(upload)}
              className="px-3 pt-3"
            />
            {/* Structured "@" mentions render as removable chips above the input. */}
            {mentions.mentions.length > 0 ? <div className="px-3 pt-3">{mentions.chips}</div> : null}
            <PromptInputTextarea
              placeholder="Work on anything"
              aria-label="Work on anything"
              onSelect={mentions.onTextareaSelect}
              onKeyDown={(event) => {
                mentions.onTextareaKeyDown(event); // "@" popover claims arrows/Enter/Esc first
                if (event.defaultPrevented) return;
                handleCmdKeys(event);
              }}
              className="min-h-[96px] px-4 pt-4 text-body-2-regular leading-relaxed"
            />

            {/* Bottom row: the "+" opens a floating add-context popover; the
                engine and model read as one quiet chip and the send affordance is
                a compact circular button. The skill/playbook chip and selected
                repo chips live in the sub-bar below the card. */}
            <div className="flex items-center gap-2 px-3 pb-3 pt-1">
              <div className="relative shrink-0">
                <ComposerAddButton
                  aria-label="Add context"
                  open={addMenuOpen}
                  onToggle={() => setAddMenuOpen((o) => !o)}
                />

                {/* Floating add-context popover (upload, Create seeds, GitHub
                    status). It floats above the "+" instead of an attached shelf;
                    the toggle and every row handler are unchanged. Repository
                    selection lives in the notch below, not here (single entry). */}
                {addMenuOpen ? (
                  <div
                    role="menu"
                    aria-label="Add context"
                    className="absolute top-full left-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] origin-top-left rounded-[14px] border border-border-button-default bg-background-primary-default p-1.5 shadow-card"
                  >
                    <AddFilesRow
                      inline
                      onPick={() => {
                        setAddMenuOpen(false);
                        fileInput.current?.click();
                      }}
                    />

                    <AddMenuDivider />

                    {/* Create: colored BoardUI plugin icons that seed a real artifact task. */}
                    <CreateRows
                      inline
                      onSeed={(seed) => {
                        setAddMenuOpen(false);
                        setPrompt((prev) => (prev.trim() ? prev : seed));
                      }}
                    />

                    <AddMenuDivider />

                    {/* GitHub is connected server-side via the GitHub App - a status row. */}
                    <GithubConnectedRow inline />
                  </div>
                ) : null}
              </div>

              {/* Permission for the new thread, the panel's faces over the run's mode
                  (Auto, Manual, Plan mode, Bypass all); rides POST /api/runs as permission_mode. */}
              <PermissionModeChip mode={permissionMode} onChange={setChosenMode} engine={engine} />
              {/* Desktop app only: Local (this machine) or Cloud for the new thread; rides POST /api/runs as run_location. */}
              <RunLocationMenu bridge={bridge} location={runLocation} onChange={setRunLocation} disabled={submitting} />
              {submitting ? (
                /* Status swap while the run is being created: the pickers are
                   inert (the fieldset is disabled), so the row's middle becomes
                   the thinking indicator until navigation or failure. */
                <div className="flex min-w-0 flex-1 items-center overflow-hidden px-1.5">
                  <AgentThinking variant="wave" label="Starting the run" showTimer={false} />
                </div>
              ) : (
                /* Engine and model read as one quiet chip on the right: the rail
                   inside the picker chooses the engine, the rows its model. */
                <div className="ml-auto flex min-w-0 flex-nowrap items-center overflow-hidden">
                  <ModelPicker
                    providers={providers}
                    value={model}
                    providerId={engine}
                    onChange={(nextModel, nextEngine) => {
                      modelPicked.current = true;
                      setEngine(nextEngine);
                      setModel(nextModel);
                    }}
                    effort={reasoningEffort}
                    onEffortChange={(next) => setReasoningEffort(next || null)}
                    placement="bottom end"
                    className="h-8 min-w-0 max-w-[16rem] rounded-full px-2.5 text-body-2-medium text-text-secondary"
                  />
                </div>
              )}
              {/* Compact dark circular send (ai-kit reference): disabled only while
                  actually submitting or uploads are blocked; an empty-prompt click
                  is a no-op (submit guards on empty). The label rides aria-label
                  for "Start thread". */}
              <Button
                variant="neutral"
                iconOnly
                leadingIcon={RiArrowUpLine}
                aria-label="Start thread"
                onClick={() => void submit()}
                disabled={submitting || runUploads.blocked}
                className="size-9 shrink-0 rounded-full p-0"
              />
            </div>
          </div>
        </PromptInput>
      </ComposerLoader>

      {/* Notch (second tier): tucked UNDER the card - inset margins, negative
          top margin (the z-10 card covers the seam), rounded only at the bottom.
          Carries the project chooser, the playbook/skills chip and, once repos
          are chosen, their branch pickers. Wrapped in a disabled fieldset so it
          goes inert during submit, exactly like the in-card controls. */}
      <fieldset disabled={submitting} className="contents">
        <div className="relative z-0 mx-2.5 -mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-b-[16px] border-x border-b border-border-button-default bg-bg-white-0 px-3 pt-3.5 pb-1.5">
          {/* Project chooser: the same repositories selector as the "+" menu,
              rendered as the notch's quiet "Choose project" chip. */}
          <RepoMultiPicker
            repos={repos}
            value={selectedRepos}
            onChange={setSelectedRepos}
            emptyLabel="Choose project"
            triggerClassName="rounded-full px-2 py-1 text-body-2-medium text-text-secondary"
          />

          {/* Skill/playbook, demoted to a quiet chip in the notch. */}
          <SearchablePicker
            ariaLabel="Select playbook or skill"
            triggerLabel="Playbook or skills"
            searchPlaceholder="Search playbooks & skills..."
            groups={skillGroups}
            value={playbook}
            onChange={setPlaybook}
            triggerClassName="max-w-[16rem] rounded-full text-text-secondary"
          />

          {selectedRepoItems.length > 0 ? (
            <RepoBranchBar repos={selectedRepoItems} value={branches} onChange={setBranches} />
          ) : null}
        </div>
      </fieldset>

      {error ? (
        <p role="alert" className="mt-2 text-caption-1-regular text-text-error-primary">
          {error}
          {errorKey ? (
            <>
              {" "}
              <AddProviderKey provider={errorKey} onClick={() => startFree.openForm(errorKey)} />
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
