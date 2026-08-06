"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  RiCpuLine,
  RiFlashlightLine,
  RiFolderLine,
  RiGitBranchLine,
  RiHardDrive2Line,
} from "@remixicon/react";
import * as Switch from "@/components/ui/switch";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import { backendFetch } from "@/lib/backend-fetch";
import { ENGINES, type EngineId } from "@/components/chat/types";
import {
  filterCommands,
  SlashCommandPopover,
  type SlashCommand,
} from "@/components/chat/slash-command";
import type { Skill } from "./skills-data";
import { SearchablePicker, type PickerGroup } from "./searchable-picker";

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

const MACHINES: { value: string; label: string; mono: boolean }[] = [
  { value: "snapshot-2026-07-24", label: "snapshot-2026-07-24", mono: true },
  { value: "snapshot-2026-07-19", label: "snapshot-2026-07-19", mono: true },
  { value: "fresh", label: "Fresh machine", mono: false },
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

const machineGroups: PickerGroup[] = [
  {
    label: "Machines",
    options: MACHINES.map((m) => ({
      value: m.value,
      label: m.label,
      icon: RiHardDrive2Line,
      mono: m.mono,
    })),
  },
];

const engineGroups: PickerGroup[] = [
  {
    label: "Engines",
    options: ENGINES.map((e) => ({
      value: e.id,
      label: e.label,
      caption: ENGINE_CAPTIONS[e.id],
      icon: RiCpuLine,
    })),
  },
];

/**
 * The New Task composer: a prompt textarea over a control row of searchable
 * pickers (repo / playbook / model / engine / machine), a secondary row
 * (branch + "Plan first"), and the "Start agent" CTA. Client-side because it
 * owns every selection, the prompt, and the POST → redirect.
 *
 * `skills` are the local playbook seed. Only the prompt (with the playbook name
 * appended when one is chosen), the model and the engine are sent to
 * POST /api/runs; on success it routes to the run's /session view.
 */
export function NewTaskComposer({ skills }: { skills: Skill[] }) {
  const router = useRouter();

  const [prompt, setPrompt] = useState("");
  const [repo, setRepo] = useState(""); // "" → No repo
  const [repos, setRepos] = useState<{ full_name: string; name: string }[]>([]);
  const [playbook, setPlaybook] = useState(""); // "" → No playbook
  const [model, setModel] = useState(MODELS[0].value);
  const [machine, setMachine] = useState(MACHINES[0].value);
  const [engine, setEngine] = useState<string>(ENGINES[0].id);
  const [branch, setBranch] = useState("main");
  const [planFirst, setPlanFirst] = useState(false);
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

  // Real repositories for the repo picker (GET /api/repos — the backend-held
  // GitHub token stays server-side). Empty when unconfigured, so the picker
  // simply offers "No repo".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await backendFetch("/api/repos");
        if (!res.ok) return;
        const data = (await res.json()) as {
          repos?: { full_name?: string; name?: string }[];
        };
        if (cancelled || !Array.isArray(data.repos)) return;
        setRepos(
          data.repos
            .filter((r): r is { full_name: string; name?: string } => !!r.full_name)
            .map((r) => ({ full_name: r.full_name, name: r.name ?? r.full_name })),
        );
      } catch {
        // no repos configured — the picker just offers "No repo"
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

  const playbookGroups: PickerGroup[] = useMemo(() => {
    const options = skills.map((s) => ({
      value: s.id,
      label: s.name,
      caption: s.tags[0],
      icon: RiFlashlightLine,
    }));
    const groups: PickerGroup[] = [{ options: [{ value: "", label: "No playbook" }] }];
    if (options.length > 0) {
      groups.push({ label: "Recents", options: options.slice(0, 2) });
      groups.push({ label: "Playbooks", options });
    }
    return groups;
  }, [skills]);

  // Repo picker groups: a "No repo" default first, then the real repos. Value is
  // the full "owner/name" (what the backend validates + persists); the label is
  // the bare repo name for readability.
  const repoGroups: PickerGroup[] = useMemo(() => {
    const groups: PickerGroup[] = [{ options: [{ value: "", label: "No repo" }] }];
    if (repos.length > 0) {
      groups.push({
        label: "Repos",
        options: repos.map((r) => ({ value: r.full_name, label: r.name, icon: RiFolderLine })),
      });
    }
    return groups;
  }, [repos]);

  const canSubmit = prompt.trim().length > 0 && !submitting;

  async function submit() {
    const text = prompt.trim();
    if (!text) return;
    setSubmitting(true);
    setError(null);

    const playbookName = skills.find((s) => s.id === playbook)?.name;
    const composed = playbookName ? `${text} · playbook: ${playbookName}` : text;

    try {
      const res = await backendFetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `model` only applies to opencode (any-model sandbox); other engines
        // manage their own model, so omit it for them.
        body: JSON.stringify({
          prompt: composed,
          engine,
          ...(engine === "opencode" ? { model } : {}),
          ...(repo ? { repo } : {}),
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
      <div className="overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-sm">
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
              placeholder="Describe the task — repo, goal, constraints..."
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
            <SearchablePicker
              ariaLabel="Select repository"
              triggerLabel="Repo"
              searchPlaceholder="Search folders, repos..."
              groups={repoGroups}
              value={repo}
              onChange={setRepo}
            />
            <SearchablePicker
              ariaLabel="Select playbook"
              triggerLabel="Playbook"
              searchPlaceholder="Search playbooks..."
              groups={playbookGroups}
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
            <SearchablePicker
              ariaLabel="Select machine"
              triggerLabel="Machine"
              searchPlaceholder="Search machines..."
              groups={machineGroups}
              value={machine}
              onChange={setMachine}
            />
          </div>

          {/* Secondary controls + CTA */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stroke-soft-200 pt-3">
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-1.5 rounded-xl border border-stroke-soft-200 px-2 py-1.5">
                <RiGitBranchLine className="size-4 shrink-0 text-text-sub-600" aria-hidden />
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  aria-label="Branch"
                  className="w-24 min-w-0 bg-transparent font-mono text-paragraph-xs text-text-strong-950 outline-none placeholder:text-text-soft-400"
                />
              </label>

              <label className="flex items-center gap-2.5">
                <Switch.Root
                  checked={planFirst}
                  onCheckedChange={setPlanFirst}
                  aria-label="Plan first"
                />
                <span className="text-label-sm text-text-strong-950">Plan first</span>
                <span className="text-paragraph-xs text-text-soft-400">
                  Review a plan before any edits
                </span>
              </label>
            </div>

            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-bg-strong-950 px-4 py-2 text-label-sm text-text-white-0 outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
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
