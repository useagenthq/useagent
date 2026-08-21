"use client";

import {
  RiAddLine,
  RiAttachment2,
  RiBookMarkedLine,
  RiCpuLine,
  RiFlashlightLine,
  RiGithubLine,
} from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
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
  selectableModelsForEngine,
} from "@/components/chat/types";
import { PromptInput, PromptInputTextarea } from "@/components/prompt-kit/prompt-input";
import { backendFetch } from "@/lib/backend-fetch";
import { cnExt } from "@/utils/cn";
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

/** Full-width row styling for the controls inside the "+" action shelf. */
const ADD_MENU_ROW =
  "flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left text-label-sm text-text-strong-950 transition-colors hover:bg-bg-weak-50";

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
  const [model, setModel] = useState(selectableModelsForEngine("opencode")[0]?.value ?? "");
  const [engine, setEngine] = useState<string>(ENGINES[0].id);
  // The "+" action shelf under the composer holds the add-context controls
  // (upload, repos, skills, GitHub, branches) so the toolbar row never overflows.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Only offer engines the SERVER enabled (GET /api/config, gated by
  // ENABLED_ENGINES): claude/codex surface here only on a backend that turned them
  // on, so the picker never lets a user start a run the backend would 403. This is
  // the capability-driven engine manifest (final_harness Phase 2).
  const engineConfig = useEnabledEngineConfig();
  const enabledEngines = engineConfig.engines;
  const engineId = engine as EngineId;
  const selectableModels = modelOptionsForEngine(engineId, engineConfig.models[engineId]);
  const modelGroups: PickerGroup[] = useMemo(
    () => [
      {
        label: "Models",
        options: selectableModels.map((m) => ({
          value: m.value,
          label: m.label,
          markTint: m.tint,
        })),
      },
    ],
    [selectableModels],
  );
  // Per-repo branch overrides (repo full_name -> branch). An absent entry means
  // "clone the repo's default branch"; only overrides are sent to the backend.
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const runUploads = useRunUploads();

  useEffect(() => {
    const resolved = resolveEnabledEngine(engineId, enabledEngines);
    if (resolved && resolved !== engineId) setEngine(resolved);
  }, [enabledEngines, engineId]);

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

  const canSubmit = prompt.trim().length > 0 && !submitting && !runUploads.blocked;

  async function submit() {
    const text = prompt.trim();
    if (!text) return;
    setSubmitting(true);
    setError(null);

    // Skill/playbook selection is a REAL run contract now — send { id, version }
    // so the backend pins the immutable revision and injects its SKILL.md as
    // engine instructions. The user's prompt stays CLEAN (no name decoration).
    const selectedSkill = skills.find((s) => s.id === playbook);

    // Per-repo branch overrides: only send entries for SELECTED repos whose
    // chosen branch differs from the repo's default (a bare repo = default
    // branch on the backend), so the payload stays minimal and honest.
    const branchPayload: Record<string, string> = {};
    for (const item of selectedRepoItems) {
      const chosen = branches[item.full_name];
      if (chosen && chosen !== item.default_branch) branchPayload[item.full_name] = chosen;
    }

    try {
      const res = await backendFetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send a model only for engines with an explicit picker/catalog. Codex
        // uses bare backend-policy ids; OpenCode uses provider-qualified ids.
        body: JSON.stringify({
          prompt: text,
          engine,
          memory_scope: "org",
          ...(selectableModels.length > 0 ? { model } : {}),
          ...(selectedRepos.length ? { repos: selectedRepos } : {}),
          ...(Object.keys(branchPayload).length ? { branches: branchPayload } : {}),
          ...(runUploads.readyIds.length > 0 ? { attachments: runUploads.readyIds } : {}),
          ...(selectedSkill
            ? { skill: { id: selectedSkill.id, version: selectedSkill.version } }
            : {}),
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { id?: string };
      if (!data.id) throw new Error("missing run id");
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
          and rides POST /api/runs on submit. */}
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
        className="rounded-[20px] p-2 shadow-regular-md transition-colors"
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
        <div className="relative">
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
          {runUploads.uploads.length > 0 ? (
            <div className="px-3 pt-3">
              <RunUploadChips
                uploads={runUploads.uploads}
                onRemove={(upload) => void runUploads.remove(upload)}
              />
            </div>
          ) : null}
          <PromptInputTextarea
            placeholder="Describe what you need - task, question, repo, constraints..."
            aria-label="Describe what you need"
            onKeyDown={(event) => {
              handleCmdKeys(event);
            }}
            className="min-h-[84px] px-3.5 pt-3.5 text-paragraph-sm leading-relaxed"
          />

          {/* Toolbar: the "+" opens the add-context shelf below; engine + model +
              Start stay inline. The context controls (repos, skills, GitHub,
              branches) live in the shelf, so this row never overflows. */}
          <div className="flex items-center gap-1 px-2 pb-2">
            <button
              type="button"
              aria-label="Add context"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((o) => !o)}
              className={cnExt(
                "grid size-8 shrink-0 place-items-center rounded-[10px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-stroke-strong-950",
                addMenuOpen
                  ? "bg-bg-weak-50 text-text-strong-950"
                  : "text-text-sub-600 hover:bg-bg-weak-50",
              )}
            >
              <RiAddLine
                className={cnExt(
                  "size-5 transition-transform duration-200",
                  addMenuOpen && "rotate-45",
                )}
                aria-hidden
              />
            </button>
            <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-x-auto">
              <SearchablePicker
                ariaLabel="Select engine"
                triggerLabel="Engine"
                searchPlaceholder="Search engines..."
                groups={engineGroups}
                value={engine}
                onChange={setEngine}
              />
              {/* Model is shown only for engines whose backend policy accepts an
                  explicit user choice (OpenCode and Codex). */}
              {selectableModels.length > 0 ? (
                <SearchablePicker
                  ariaLabel="Select model"
                  triggerLabel="Model"
                  searchPlaceholder="Search models..."
                  groups={modelGroups}
                  value={model}
                  onChange={setModel}
                />
              ) : null}
              {/* Skill/playbook sits beside the model; the trigger truncates a long
                  name so it never widens the row. */}
              <SearchablePicker
                ariaLabel="Select playbook or skill"
                triggerLabel="Playbook or skills"
                searchPlaceholder="Search playbooks & skills..."
                groups={skillGroups}
                value={playbook}
                onChange={setPlaybook}
                triggerClassName="max-w-[11rem]"
              />
            </div>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="inline-flex h-9 shrink-0 items-center justify-center rounded-full bg-bg-strong-950 px-5 text-label-sm text-text-white-0 outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "Starting..." : "Start thread"}
            </button>
          </div>
        </div>
      </PromptInput>

      {/* The "+" action shelf (ai-kit ACTION MENU VARIANT): the add-context
          controls live here as full-width rows so the toolbar never overflows.
          Every row is real - upload, the repo multi-select, the skill picker,
          per-repo branches, and GitHub (already connected server-side). */}
      {addMenuOpen ? (
        <div className="mt-1.5 rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-1.5 shadow-regular-md">
          <button
            type="button"
            onClick={() => {
              setAddMenuOpen(false);
              fileInput.current?.click();
            }}
            className={ADD_MENU_ROW}
          >
            <RiAttachment2 className="size-[18px] shrink-0 text-text-sub-600" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-label-sm text-text-strong-950">Add photos &amp; files</span>
              <span className="text-paragraph-xs text-text-soft-400">Upload from computer</span>
            </span>
          </button>

          <RepoMultiPicker
            repos={repos}
            value={selectedRepos}
            onChange={setSelectedRepos}
            triggerClassName={ADD_MENU_ROW}
          />

          {selectedRepoItems.length > 0 ? (
            <div className="px-2.5 py-1.5">
              <RepoBranchBar repos={selectedRepoItems} value={branches} onChange={setBranches} />
            </div>
          ) : null}

          <div className="my-1 border-t border-stroke-soft-200" />

          {/* GitHub is connected server-side via the GitHub App (that is why the
              repo list loads) - so this is a status row, not a "Connect" action. */}
          <div className={cnExt(ADD_MENU_ROW, "cursor-default hover:bg-transparent")}>
            <RiGithubLine className="size-[18px] shrink-0 text-text-sub-600" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-label-sm text-text-strong-950">GitHub</span>
              <span className="text-paragraph-xs text-text-soft-400">
                Read pull requests &amp; issues
              </span>
            </span>
            <span className="rounded-full bg-bg-weak-50 px-2 py-0.5 text-label-xs text-text-sub-600">
              Connected
            </span>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-paragraph-xs text-error-base">
          {error}
        </p>
      ) : null}
    </div>
  );
}
