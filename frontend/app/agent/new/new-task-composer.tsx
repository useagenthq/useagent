"use client";

import { useMemo, useState } from "react";
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
import type { Skill } from "./skills-data";
import { SearchablePicker, type PickerGroup } from "./searchable-picker";

/** Mock repositories — no repo backend yet. */
const REPOS = ["skynet-app", "skynet-web", "skynet-infra", "chartden"];

// Real backend model ids (`value`, sent verbatim in the POST body) paired with a
// friendly `label`. Only meaningful for the opencode engine — see the picker below.
const MODELS: { value: string; label: string; tint: string }[] = [
  { value: "claude-opus-5", label: "Opus 5", tint: "text-orange-500" },
  { value: "claude-sonnet-5", label: "Sonnet 5", tint: "text-blue-500" },
  { value: "claude-fable-5", label: "Fable 5", tint: "text-purple-500" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", tint: "text-green-500" },
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

const repoGroups: PickerGroup[] = [
  {
    label: "Recents",
    options: [REPOS[0], REPOS[3]].map((r) => ({ value: r, label: r, icon: RiFolderLine })),
  },
  {
    label: "Repos",
    options: REPOS.map((r) => ({ value: r, label: r, icon: RiFolderLine })),
  },
];

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
  const [repo, setRepo] = useState(REPOS[0]);
  const [playbook, setPlaybook] = useState(""); // "" → No playbook
  const [model, setModel] = useState(MODELS[0].value);
  const [machine, setMachine] = useState(MACHINES[0].value);
  const [engine, setEngine] = useState<string>(ENGINES[0].id);
  const [branch, setBranch] = useState("main");
  const [planFirst, setPlanFirst] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            placeholder="Describe the task — repo, goal, constraints..."
            aria-label="Describe the task"
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
            className="min-h-[104px] w-full resize-none bg-transparent px-1 text-paragraph-md text-text-strong-950 outline-none placeholder:text-text-soft-400"
          />

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
