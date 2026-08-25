"use client";

import {
  RiBookMarkedLine,
  RiPlayMiniLine,
  RiSearchLine,
} from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/base/buttons/button";
import { InputBase } from "@/components/base/input/input";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { visibleDescription } from "@/components/customize/list-row";
import { cx } from "@/utils/cx";
import { fetchSkills } from "@/app/skills/skills-api";
import { usageCaption, type Skill } from "@/app/skills/skills-data";
import { PlaybookDetail } from "./playbook-detail";
import { PlaybookEditor } from "./playbook-editor";

/**
 * Client owner for the Playbooks page. Playbooks are versioned skills with
 * `kind: "playbook"` (one substrate, mem_op doctrine), so this reuses the shared
 * skills client scoped to that kind. The list is compact scannable rows - name,
 * clamped description, and a real meta line (version, procedure length, usage) -
 * with client-side search once the library outgrows a screenful. A row opens a
 * read-only detail; detail hosts Edit (mints a new version) and Run. Running a
 * playbook opens the New Task composer with it preselected - the same
 * run-with-skill path a skill uses - so the agent loads the procedure as
 * governing context, not a separate executor.
 */

/** Search appears only once the library exceeds a scannable screenful. */
const SEARCH_THRESHOLD = 8;

/** "v3 · 6 steps · Used 14 times · last run 2d ago" - every part real. */
function playbookMeta(playbook: Skill): string {
  const steps = playbook.sections.procedure.length;
  const parts = [`v${playbook.version}`];
  if (steps > 0) parts.push(`${steps} ${steps === 1 ? "step" : "steps"}`);
  parts.push(usageCaption(playbook));
  return parts.join(" · ");
}

function PlaybookRow({
  playbook,
  onOpen,
  onRun,
}: {
  playbook: Skill;
  onOpen: (playbook: Skill) => void;
  onRun: (playbook: Skill) => void;
}) {
  // Single-line row: title (+ a non-redundant description inline), the real meta
  // right-aligned and muted, one action. The common "Playbook: <title>"
  // description restates the title, so it is suppressed.
  const description = visibleDescription(playbook.name, playbook.description);
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-background-primary-hover">
      <button
        type="button"
        onClick={() => onOpen(playbook)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiBookMarkedLine
          aria-hidden
          className="size-4 shrink-0 text-foreground-icon-secondary"
        />
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-body-medium text-text-primary">
            {playbook.name}
          </span>
          {description && (
            <span className="truncate text-caption-1-regular text-text-secondary">
              {description}
            </span>
          )}
        </span>
      </button>
      <span className="hidden shrink-0 text-caption-1-regular tabular-nums text-text-tertiary sm:block">
        {playbookMeta(playbook)}
      </span>
      <Button
        variant="ghost"
        size="xs"
        className="rounded-full"
        leadingIcon={RiPlayMiniLine}
        aria-label={`Run ${playbook.name}`}
        onClick={() => onRun(playbook)}
      >
        Run
      </Button>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="mt-6 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border-button-default px-6 py-16 text-center">
      <RiBookMarkedLine
        aria-hidden
        className="size-6 text-foreground-icon-tertiary"
      />
      <p className="mt-3 text-body-2-medium text-text-primary">No playbooks yet</p>
      <p className="mt-1 max-w-xs text-body-2-regular text-text-secondary">
        Capture your first procedure to get started.
      </p>
    </div>
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
  const [query, setQuery] = useState("");
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

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return playbooks;
    return playbooks.filter(
      (playbook) =>
        playbook.name.toLowerCase().includes(q) ||
        playbook.description.toLowerCase().includes(q) ||
        playbook.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [playbooks, q]);

  const searchable = playbooks.length > SEARCH_THRESHOLD;

  return (
    <div className="mx-auto w-full max-w-[880px] px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <RiBookMarkedLine
              aria-hidden
              className="size-5 text-foreground-icon-primary"
            />
            <h1 className="text-title-2-medium text-text-primary">Playbooks</h1>
          </div>
          <p className="mt-1.5 text-body-2-regular text-text-secondary">
            Structured procedures useAgent follows as guidance - Overview,
            Procedure, Verify
          </p>
        </div>
        <Button variant="primary" onClick={openCreate}>
          New playbook
        </Button>
      </div>

      {playbooks.length === 0 ? (
        error ? (
          <BackendUnreachable className="mt-10" onRetry={refetch} />
        ) : (
          <EmptyState />
        )
      ) : (
        <>
          {searchable && (
            <div className="mt-6">
              <InputBase
                size="small"
                aria-label="Search playbooks"
                placeholder="Search playbooks…"
                leadingIcon={RiSearchLine}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                fieldClassName="sm:w-72"
              />
            </div>
          )}

          {visible.length === 0 ? (
            <p className="mt-6 text-body-2-regular text-text-secondary">
              No playbooks match &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            <ul
              className={cx(
                searchable ? "mt-3" : "mt-6",
                "divide-y divide-separator-border overflow-hidden rounded-2xl bg-background-primary-default shadow-sm ring-1 ring-inset ring-border-button-default",
              )}
            >
              {visible.map((playbook) => (
                <PlaybookRow
                  key={playbook.id}
                  playbook={playbook}
                  onOpen={openDetail}
                  onRun={runPlaybook}
                />
              ))}
            </ul>
          )}
        </>
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
