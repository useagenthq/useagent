"use client";

import {
  RiAddLine,
  RiArrowUpLine,
  RiBookMarkedLine,
  RiCloseLine,
  RiCpuLine,
  RiFlashlightLine,
} from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AddFilesRow,
  AddMenuDivider,
  CreateRows,
  GithubConnectedRow,
} from "@/components/chat/composer-add-menu";
import { mentionsToRunResources, useComposerMentions } from "@/components/chat/composer-mentions-ui";
import { resolveEnabledEngine, useEnabledEngineConfig } from "@/components/chat/engine-picker";
import { RunUploadChips, useRunUploads } from "@/components/chat/run-uploads";
import {
  type CommandPickerStatus,
  filterCommands,
  type SlashCommand,
  SlashCommandPopover,
  slashInsertText,
} from "@/components/chat/slash-command";
import {
  ENGINES,
  type EngineId,
  modelOptionsForEngine,
  partitionModelOptions,
  selectableModelsForEngine,
} from "@/components/chat/types";
import { AgentThinking } from "@/components/application/agent-thinking/agent-thinking";
import { ComposerLoader } from "@/components/application/composer-loader/composer-loader";
import { Button } from "@/components/base/buttons/button";
import { PromptInput, PromptInputTextarea } from "@/components/prompt-kit/prompt-input";
import { backendFetch } from "@/lib/backend-fetch";
import {
  createRun,
  type RunCreateAttempt,
  selectRunCreateAttempt,
} from "@/lib/create-run";
import { cx } from "@/utils/cx";
import { RepoBranchBar } from "./repo-branch-bar";
import { type RepoItem, RepoMultiPicker } from "./repo-multi-picker";
import { type PickerGroup, SearchablePicker } from "./searchable-picker";
import type { Skill } from "./skills-data";

/** Composer-specific caption for each selectable engine (POST /api/runs `engine`).
 * Partial because the legacy EngineId values are never offered in the picker, so
 * they need no caption. */
const ENGINE_CAPTIONS: Partial<Record<EngineId, string>> = {
  chat: "direct model · no sandbox",
  opencode: "any model · cloud sandbox",
  claude: "cloud sandbox",
  codex: "cloud sandbox",
};

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
  // Codex is the preferred default engine (user decision 2026-08-23); the
  // manifest effect below demotes it only AFTER the server manifest loads
  // without codex, so the default survives the pre-fetch fallback window.
  const [model, setModel] = useState(selectableModelsForEngine("codex")[0]?.value ?? "");
  const [engine, setEngine] = useState<string>("codex");
  // The "+" action shelf under the composer holds the add-context controls
  // (upload, repos, skills, GitHub, branches) so the toolbar row never overflows.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Only offer engines the SERVER enabled (GET /api/config, gated by
  // ENABLED_ENGINES): claude/codex surface here only on a backend that turned them
  // on, so the picker never lets a user start a run the backend would 403. This is
  // the capability-driven engine manifest.
  const engineConfig = useEnabledEngineConfig();
  const enabledEngines = engineConfig.engines;
  const engineId = engine as EngineId;
  const selectableModels = modelOptionsForEngine(engineId, engineConfig.models[engineId]);
  const modelGroups: PickerGroup[] = useMemo(() => {
    const toOption = (m: (typeof selectableModels)[number]) => ({
      value: m.value,
      label: m.label,
      markTint: m.tint,
    });
    // Zero-cost OpenRouter ":free" variants (OpenCode only) get their own
    // section; membership is manifest-driven via the shared partition.
    const { paid, free } = partitionModelOptions(selectableModels);
    const groups: PickerGroup[] = [{ label: "Models", options: paid.map(toOption) }];
    if (free.length > 0) groups.push({ label: "Free", options: free.map(toOption) });
    return groups;
  }, [selectableModels]);
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

  useEffect(() => {
    if (selectableModels.length === 0) return;
    if (!selectableModels.some((m) => m.value === model)) {
      setModel(selectableModels[0]?.value ?? "");
    }
  }, [model, selectableModels]);

  // Real repositories for the multi-select repo picker (GET /api/repos — the
  // backend-held GitHub token stays server-side). Empty when unconfigured, so the
  // picker just shows "No repositories available".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await backendFetch("/api/repos");
        if (!res.ok) return;
        const data = (await res.json()) as {
          repos?: {
            full_name?: string;
            name?: string;
            private?: boolean;
            default_branch?: string;
          }[];
        };
        if (cancelled || !Array.isArray(data.repos)) return;
        const offeredRepos = data.repos
          .filter(
            (
              r,
            ): r is {
              full_name: string;
              name?: string;
              private?: boolean;
              default_branch?: string;
            } => !!r.full_name,
          )
          .map((r) => ({
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

  // The engine picker's options, filtered to the server-enabled set.
  const engineGroups: PickerGroup[] = useMemo(
    () => [
      {
        label: "Engines",
        options: ENGINES.filter((e) => e.id !== "chat" && enabledEngines.includes(e.id)).map(
          (e) => ({
            value: e.id,
            label: e.label,
            caption: ENGINE_CAPTIONS[e.id],
            icon: RiCpuLine,
          }),
        ),
      },
    ],
    [enabledEngines],
  );

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

    const body = {
      // Send a model only for engines with an explicit picker/catalog. Codex
      // uses bare backend-policy ids; OpenCode uses provider-qualified ids.
      prompt: text,
      engine,
      memory_scope: "org",
      ...(selectableModels.length > 0 ? { model } : {}),
      ...(selectedRepos.length ? { repos: selectedRepos } : {}),
      ...(Object.keys(branchPayload).length ? { branches: branchPayload } : {}),
      ...(mentionResources.length ? { resources: mentionResources } : {}),
      ...(runUploads.readyIds.length > 0 ? { attachments: runUploads.readyIds } : {}),
      ...(selectedSkill
        ? { skill: { id: selectedSkill.id, version: selectedSkill.version } }
        : {}),
    };
    const attempt = selectRunCreateAttempt(body, runCreateAttempt.current);
    runCreateAttempt.current = attempt;

    try {
      const res = await createRun(body, attempt.idempotencyKey);
      if (!res.ok) throw new Error(String(res.status));
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

  return (
    <div>
      {/* Composer card modeled on the ai-kit KnowledgeComposerCard: an outer card
          wrapping a darker inset that holds the prompt textarea and a clean pill
          toolbar. Every control is real - attach, repos, engine, model, skill -
          and rides POST /api/runs on submit.

          While the run is being created (click -> navigation) the ComposerLoader
          rim light carries the working state: it paints the card surface itself,
          so the PromptInput goes transparent (bg/border/shadow) for that window
          and hands the surface back when idle. Geometry is untouched. */}
      <ComposerLoader active={submitting} radius={16} className="relative z-10">
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
            "rounded-[16px] p-2 shadow-card transition-colors",
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
          <div className="relative" ref={composerRef}>
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
            {runUploads.uploads.length > 0 ? (
              <div className="px-3 pt-3">
                <RunUploadChips
                  uploads={runUploads.uploads}
                  onRemove={(upload) => void runUploads.remove(upload)}
                />
              </div>
            ) : null}
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
                <button
                  type="button"
                  aria-label="Add context"
                  aria-haspopup="menu"
                  aria-expanded={addMenuOpen}
                  onClick={() => setAddMenuOpen((o) => !o)}
                  className={cx(
                    "grid size-9 cursor-pointer place-items-center rounded-full bg-background-secondary-default outline-none transition-colors hover:bg-background-secondary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                    addMenuOpen ? "text-text-primary" : "text-text-secondary",
                  )}
                >
                  {addMenuOpen ? (
                    <RiCloseLine className="size-[18px]" aria-hidden />
                  ) : (
                    <RiAddLine className="size-[18px]" aria-hidden />
                  )}
                </button>

                {/* Floating add-context popover (upload, Create seeds, GitHub
                    status). It floats above the "+" instead of an attached shelf;
                    the toggle and every row handler are unchanged. Repository
                    selection lives in the notch below, not here (single entry). */}
                {addMenuOpen ? (
                  <div
                    role="menu"
                    aria-label="Add context"
                    className="absolute top-full left-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] origin-top-left rounded-[14px] border border-border-button-default bg-background-primary-default p-2 shadow-card"
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

              {submitting ? (
                /* Status swap while the run is being created: the pickers are
                   inert (the fieldset is disabled), so the row's middle becomes
                   the thinking indicator until navigation or failure. */
                <div className="flex min-w-0 flex-1 items-center overflow-hidden px-1.5">
                  <AgentThinking variant="wave" label="Starting the run" showTimer={false} />
                </div>
              ) : (
                /* Engine and model read as one compact quiet chip on the right:
                   the engine name, a dot, then the model, with a single chevron. */
                <div className="ml-auto flex min-w-0 flex-nowrap items-center gap-0.5 overflow-hidden">
                  <SearchablePicker
                    ariaLabel="Select engine"
                    triggerLabel="Engine"
                    searchPlaceholder="Search engines..."
                    groups={engineGroups}
                    value={engine}
                    onChange={setEngine}
                    hideChevron={selectableModels.length > 0}
                    triggerClassName="h-8 shrink-0 rounded-full px-2 text-caption-1-medium text-text-secondary"
                  />
                  {/* Model is shown only for engines whose backend policy accepts an
                      explicit user choice (OpenCode and Codex). */}
                  {selectableModels.length > 0 ? (
                    <>
                      <span aria-hidden className="shrink-0 select-none text-text-tertiary">
                        ·
                      </span>
                      <SearchablePicker
                        ariaLabel="Select model"
                        triggerLabel="Model"
                        searchPlaceholder="Search models..."
                        groups={modelGroups}
                        value={model}
                        onChange={setModel}
                        triggerClassName="h-8 min-w-0 max-w-[16rem] rounded-full px-2.5 text-caption-1-medium text-text-secondary"
                      />
                    </>
                  ) : null}
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
        <div className="relative z-0 mx-2.5 -mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-b-[12px] border-x border-b border-border-button-default bg-background-tertiary-default px-3 pt-3.5 pb-1.5">
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
        </p>
      ) : null}
    </div>
  );
}
