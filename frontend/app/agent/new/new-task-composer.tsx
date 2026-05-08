"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  RiBookMarkedLine,
  RiCpuLine,
  RiFlashlightLine,
} from "@remixicon/react";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import { backendFetch } from "@/lib/backend-fetch";
import { ENGINES, type EngineId, type MemoryScope } from "@/components/chat/types";
import { MemoryScopePicker } from "@/components/chat/memory-scope-picker";
import { useEnabledEngines } from "@/components/chat/engine-picker";
import {
  filterCommands,
  SlashCommandPopover,
  type SlashCommand,
} from "@/components/chat/slash-command";
import type { Skill } from "./skills-data";
import { SearchablePicker, type PickerGroup } from "./searchable-picker";
import { RepoMultiPicker, type RepoItem } from "./repo-multi-picker";
import { RepoBranchBar } from "./repo-branch-bar";

// Real backend model ids (`value`, sent verbatim in the POST body) paired with a
// friendly `label`. Only meaningful for the opencode engine — see the picker below.
const MODELS: { value: string; label: string; tint: string }[] = [
  // Bare ids → Anthropic direct; provider/model ids → OpenRouter (the backend
  // maps them; OPENROUTER_API_KEY rides into the sandbox). Ids verified against
  // openrouter.ai/api/v1/models.
  { value: "claude-opus-5", label: "Opus 5", tint: "text-orange-500" },
  { value: "claude-sonnet-5", label: "Sonnet 5", tint: "text-blue-500" },
  { value: "claude-fable-5", label: "Fable 5", tint: "text-purple-500" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", tint: "text-green-500" },
  { value: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", tint: "text-teal-500" },
  { value: "openai/gpt-5.6-sol-pro", label: "GPT-5.6 Sol Pro", tint: "text-teal-500" },
  { value: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", tint: "text-sky-500" },
  { value: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", tint: "text-amber-500" },
];

/** Composer-specific caption for each selectable engine (POST /api/runs `engine`).
 * Partial because the legacy EngineId values are never offered in the picker, so
 * they need no caption. */
const ENGINE_CAPTIONS: Partial<Record<EngineId, string>> = {
  opencode: "any model · cloud sandbox",
  claude: "cloud sandbox",
  codex: "cloud sandbox",
};

const modelGroups: PickerGroup[] = [
  {
    label: "Models",
    options: MODELS.map((m) => ({ value: m.value, label: m.label, markTint: m.tint })),
  },
];


/**
 * The New Task composer: a prompt textarea over a control row of searchable
 * pickers (repo / playbook / engine / model), a secondary row of per-repo branch
 * pickers, and the "Start agent" CTA. Client-side because it owns every
 * selection, the prompt, and the POST → redirect.
 *
 * Every control here reaches the backend: the prompt, engine, model (opencode
 * only), selected repos, per-repo branches, memory scope and the pinned skill
 * all ride into POST /api/runs; on success it routes to the run's /session view.
 */
export function NewTaskComposer({ skills }: { skills: Skill[] }) {
  const router = useRouter();

  const [prompt, setPrompt] = useState("");
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [playbook, setPlaybook] = useState(""); // selected skill/playbook id, "" = none
  const [model, setModel] = useState(MODELS[0].value);
  const [engine, setEngine] = useState<string>(ENGINES[0].id);
  const [memoryScope, setMemoryScope] = useState<MemoryScope>("org");
  // Only offer engines the SERVER enabled (GET /api/config, gated by
  // ENABLED_ENGINES): claude/codex surface here only on a backend that turned them
  // on, so the picker never lets a user start a run the backend would 403. This is
  // the capability-driven engine manifest (final_harness Phase 2).
  const enabledEngines = useEnabledEngines();
  // Per-repo branch overrides (repo full_name -> branch). An absent entry means
  // "clone the repo's default branch"; only overrides are sent to the backend.
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Slash-command autocomplete for the "/" first token. The catalog is the
  // engine's real command list, cached per snapshot server-side (GET
  // /api/commands) so it is available BEFORE any sandbox exists. Selection only
  // completes the text — the command executes engine-side once the run starts.
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [cmdHighlight, setCmdHighlight] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await backendFetch("/api/commands");
        if (!res.ok) return;
        const data = (await res.json()) as {
          commands?: { name?: string; description?: string | null }[];
        };
        if (cancelled || !Array.isArray(data.commands)) return;
        setCommands(
          data.commands
            .filter((c): c is { name: string; description?: string | null } => !!c.name)
            .map((c) => ({ name: c.name, description: c.description ?? null })),
        );
      } catch {
        // no catalog cached yet — the composer simply has no "/" popover
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        setRepos(
          data.repos
            .filter(
              (r): r is { full_name: string; name?: string; private?: boolean; default_branch?: string } =>
                !!r.full_name,
            )
            .map((r) => ({
              full_name: r.full_name,
              name: r.name ?? r.full_name,
              private: r.private,
              default_branch: r.default_branch ?? "main",
            })),
        );
      } catch {
        // no repos configured — the picker shows nothing to select
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live while the FIRST token is being typed ("/rev" but not "/review x"); a
  // trailing space ends completion. Mirrors composer.tsx exactly.
  const cmdToken = /^\/([^\s]*)$/.exec(prompt.trimStart())?.[1];
  const cmdMatches =
    !cmdDismissed && commands.length && cmdToken !== undefined
      ? filterCommands(commands, cmdToken)
      : [];
  const cmdActive = cmdMatches.length > 0;

  function pickCommand(cmd: SlashCommand) {
    setPrompt(`/${cmd.name} `);
    setCmdHighlight(0);
  }

  /** Arrow/Enter/Tab/Esc drive the popover while it is open; returns true when
   *  the key was consumed so the caller skips its own Enter-submits path. */
  function handleCmdKeys(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!cmdActive) return false;
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
    if (e.key === "Escape") {
      e.preventDefault();
      setCmdDismissed(true);
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
        options: ENGINES.filter((e) => enabledEngines.includes(e.id)).map((e) => ({
          value: e.id,
          label: e.label,
          caption: ENGINE_CAPTIONS[e.id],
          icon: RiCpuLine,
        })),
      },
    ],
    [enabledEngines],
  );

  // One combined picker over the shared substrate: a "None" option, then Skills
  // and Playbooks as separate groups (the run pins exactly one, either kind).
  const skillGroups: PickerGroup[] = useMemo(() => {
    const toOption = (s: Skill) => ({
      value: s.id,
      label: s.name,
      caption: s.tags[0],
      icon: s.kind === "playbook" ? RiBookMarkedLine : RiFlashlightLine,
    });
    const skillOptions = skills.filter((s) => s.kind === "skill").map(toOption);
    const playbookOptions = skills.filter((s) => s.kind === "playbook").map(toOption);
    const groups: PickerGroup[] = [{ options: [{ value: "", label: "None" }] }];
    if (skillOptions.length > 0) groups.push({ label: "Skills", options: skillOptions });
    if (playbookOptions.length > 0)
      groups.push({ label: "Playbooks", options: playbookOptions });
    return groups;
  }, [skills]);

  // The selected repos (with their default_branch) drive the per-repo branch strip.
  const selectedRepoItems = useMemo(
    () => repos.filter((r) => selectedRepos.includes(r.full_name)),
    [repos, selectedRepos],
  );

  const canSubmit = prompt.trim().length > 0 && !submitting;

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
        // `model` only applies to opencode (any-model sandbox); other engines
        // manage their own model, so omit it for them.
        body: JSON.stringify({
          prompt: text,
          engine,
          memory_scope: memoryScope,
          ...(engine === "opencode" ? { model } : {}),
          ...(selectedRepos.length ? { repos: selectedRepos } : {}),
          ...(Object.keys(branchPayload).length ? { branches: branchPayload } : {}),
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
      setError("Couldn't start the agent. Check the backend and try again.");
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-sm">
      {/* No overflow-hidden: the slash-command popover drops below the textarea
          and must float over the card edge instead of clipping at it (same rule
          as the chat composer card). */}
        <div className="flex flex-col gap-3 p-3.5">
          <div className="relative">
            {cmdActive && (
              <div className="absolute left-0 top-full z-30 mt-2 w-full">
                <SlashCommandPopover
                  matches={cmdMatches}
                  highlight={Math.min(cmdHighlight, cmdMatches.length - 1)}
                  onSelect={pickCommand}
                />
              </div>
            )}
            <textarea
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                setCmdDismissed(false);
                setCmdHighlight(0);
              }}
              rows={3}
              placeholder="Describe the task - repo, goal, constraints..."
              aria-label="Describe the task"
              onKeyDown={(event) => {
                if (handleCmdKeys(event)) return; // consumed by the "/" popover
                // Plain Enter submits (chat convention); Shift+Enter = newline.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              className="min-h-[104px] w-full resize-none bg-transparent px-1 text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
            />
          </div>

          {/* Pickers */}
          <div className="flex flex-wrap items-center gap-0.5">
            <RepoMultiPicker repos={repos} value={selectedRepos} onChange={setSelectedRepos} />
            <SearchablePicker
              ariaLabel="Select skill or playbook"
              triggerLabel="Skill"
              searchPlaceholder="Search skills and playbooks..."
              groups={skillGroups}
              value={playbook}
              onChange={setPlaybook}
            />
            <SearchablePicker
              ariaLabel="Select engine"
              triggerLabel="Engine"
              searchPlaceholder="Search engines..."
              groups={engineGroups}
              value={engine}
              onChange={setEngine}
            />
            {/* Model only applies to the opencode any-model sandbox; other
                engines manage their own model, so the picker is hidden. */}
            {engine === "opencode" ? (
              <SearchablePicker
                ariaLabel="Select model"
                triggerLabel="Model"
                searchPlaceholder="Search models..."
                groups={modelGroups}
                value={model}
                onChange={setModel}
              />
            ) : null}
            {/* Team-memory pool this task reads/writes (org vs personal). */}
            <MemoryScopePicker scope={memoryScope} onChange={setMemoryScope} />
          </div>
          {/* Removed: Machine (snapshot) and "Plan first" were cosmetic - neither
              reached POST /api/runs. Snapshot selection isn't a real run option
              yet, and a plan-first/approval flow lands with the durable
              approvals workflow (task #77); re-add "Plan first" here then. */}

          {/* Per-repo branch pickers + CTA. The branch strip only appears once a
              repo is selected; every branch here is a real ref that rides into
              the run and is cloned. */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stroke-soft-200 pt-3">
            <RepoBranchBar
              repos={selectedRepoItems}
              value={branches}
              onChange={setBranches}
            />

            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-bg-strong-950 px-4 py-2 text-label-sm text-text-white-0 outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <AsteriskMark className="size-4" />
              {submitting ? "Starting…" : "Start agent"}
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-paragraph-xs text-error-base">
          {error}
        </p>
      ) : null}
    </div>
  );
}
