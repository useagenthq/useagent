"use client";

import { RiBookMarkedLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import * as Badge from "@/components/ui/badge";
import * as Button from "@/components/ui/button";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { fetchSkills } from "@/app/skills/skills-api";
import { tagChipColor, type Skill } from "@/app/skills/skills-data";
import { PlaybookDetail } from "./playbook-detail";
import { PlaybookEditor } from "./playbook-editor";

/**
 * Client owner for the Playbooks page. Playbooks are versioned skills with
 * `kind: "playbook"` (one substrate, mem_op doctrine), so this reuses the shared
 * skills client scoped to that kind. Cards open a read-only detail; detail hosts
 * Edit (mints a new version) and Run. Running a playbook opens the New Task
 * composer with it preselected - the same run-with-skill path a skill uses - so
 * the agent loads the procedure as governing context, not a separate executor.
 */

function PlaybookCard({
  playbook,
  onOpen,
}: {
  playbook: Skill;
  onOpen: (playbook: Skill) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(playbook)}
      className="flex flex-col rounded-2xl bg-bg-white-0 p-4 text-left shadow-regular-sm ring-1 ring-inset ring-stroke-soft-200 outline-none transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
    >
      <div className="flex items-center justify-between">
        <div className="flex size-9 items-center justify-center rounded-lg border border-stroke-soft-200 bg-bg-weak-50">
          <RiBookMarkedLine aria-hidden className="size-5 text-text-sub-600" />
        </div>
        <span className="font-mono text-label-xs tabular-nums text-text-soft-400">
          v{playbook.version}
        </span>
      </div>
      <h3 className="mt-3 text-label-sm text-text-strong-950">{playbook.name}</h3>
      <p className="mt-1 line-clamp-2 text-paragraph-xs text-text-sub-600">
        {playbook.description}
      </p>
      {playbook.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {playbook.tags.map((tag) => (
            <Badge.Root key={tag} variant="light" size="medium" color={tagChipColor(tag)}>
              {tag}
            </Badge.Root>
          ))}
        </div>
      )}
      <p className="mt-4 border-t border-stroke-soft-200 pt-3 text-paragraph-xs text-text-soft-400">
        Used {playbook.usageCount} {playbook.usageCount === 1 ? "time" : "times"}
      </p>
    </button>
  );
}

export function PlaybooksView({
  initialPlaybooks,
  initialLive,
  initialError,
}: {
  initialPlaybooks: Skill[];
  initialLive: boolean;
  initialError: boolean;
}) {
  const router = useRouter();
  const [playbooks, setPlaybooks] = useState<Skill[]>(initialPlaybooks);
  const [error, setError] = useState(initialError);
  const [detail, setDetail] = useState<Skill | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Skill | null>(null);

  const refetch = useCallback(async () => {
    try {
      const fresh = await fetchSkills("playbook");
      setPlaybooks(fresh);
      setError(false);
      // Keep an open detail in sync with the refetched version (e.g. after edit).
      setDetail((current) =>
        current ? (fresh.find((p) => p.id === current.id) ?? null) : null,
      );
    } catch {
      // backend still unreachable - flag the distinct error state (an empty list
      // here would masquerade an outage as "no playbooks yet")
      setError(true);
    }
  }, []);

  // Self-heal: if we SSR'd the fallback, retry once on the client.
  useEffect(() => {
    if (!initialLive) void refetch();
  }, [initialLive, refetch]);

  const openDetail = useCallback((playbook: Skill) => {
    setDetail(playbook);
    setDetailOpen(true);
  }, []);

  const openCreate = useCallback(() => {
    setEditing(null);
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((playbook: Skill) => {
    setDetailOpen(false);
    setEditing(playbook);
    setEditorOpen(true);
  }, []);

  // Running a playbook = starting a task GOVERNED by it. Open the composer with
  // the playbook preselected; the user writes the task there, and the real usage
  // bump + skill.loaded happen when that run is submitted.
  const runPlaybook = useCallback(
    (playbook: Skill) => {
      router.push(`/agent/new?skill=${encodeURIComponent(playbook.id)}`);
    },
    [router],
  );

  return (
    <div className="mx-auto w-full max-w-[1040px] px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <RiBookMarkedLine aria-hidden className="size-5 text-text-strong-950" />
            <h1 className="text-display-sm text-text-strong-950">Playbooks</h1>
          </div>
          <p className="mt-1.5 text-paragraph-sm text-text-sub-600">
            Structured procedures Skynet follows as guidance - Overview, Procedure, Verify
          </p>
        </div>
        <Button.Root
          variant="neutral"
          mode="filled"
          className="rounded-full"
          onClick={openCreate}
        >
          New playbook
        </Button.Root>
      </div>

      {playbooks.length === 0 ? (
        error ? (
          <BackendUnreachable className="mt-10" onRetry={refetch} />
        ) : (
          <p className="mt-10 text-paragraph-sm text-text-sub-600">
            No playbooks yet. Capture your first procedure to get started.
          </p>
        )
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {playbooks.map((playbook) => (
            <PlaybookCard key={playbook.id} playbook={playbook} onOpen={openDetail} />
          ))}
        </div>
      )}

      <PlaybookDetail
        open={detailOpen}
        onOpenChange={setDetailOpen}
        playbook={detail}
        onEdit={openEdit}
        onRun={runPlaybook}
      />
      <PlaybookEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editing={editing}
        onSaved={refetch}
      />
    </div>
  );
}
