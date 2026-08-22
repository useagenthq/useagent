"use client";

import { RiFlashlightLine, RiSearchLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { GithubImportSection } from "./github-import-section";
import { NewSkillModal } from "./new-skill-modal";
import { fetchSkillsLibrary } from "./skills-api";
import { groupSkills, type Skill, type SkillGroup } from "./skills-data";
import { SkillDetailDialog } from "./skill-detail-dialog";
import { SkillsList } from "./skills-list";

/** Rows rendered before "Show more" - keeps a huge imported catalog cheap. */
const SHOW_STEP = 100;

/**
 * Client owner for the Skills page. Two honest sections over the real data
 * model: "Your skills" (every org skill, hand-authored and imported, grouped
 * by name so one skill imported from several sources is ONE row) and "Import
 * from GitHub" (the real scan + import flow). Search and tag filtering are
 * client-side over the loaded list; full descriptions and per-source detail
 * live in the detail dialog. Run keeps its existing meaning: open the New Task
 * composer with the skill preselected (a skill governs a task - the usage bump
 * happens when that run is submitted).
 */
export function SkillsView({
  initialSkills,
  initialLive,
  initialError,
}: {
  initialSkills: Skill[];
  initialLive: boolean;
  initialError: boolean;
}) {
  const router = useRouter();
  const [skills, setSkills] = useState<Skill[]>(initialSkills);
  const [error, setError] = useState(initialError);
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("all");
  const [limit, setLimit] = useState(SHOW_STEP);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const refetch = useCallback(async () => {
    try {
      const fresh = await fetchSkillsLibrary("skill");
      setSkills(fresh);
      setError(false);
    } catch {
      // backend still unreachable — flag the distinct error state (an empty
      // list here would masquerade an outage as "no skills yet")
      setError(true);
    }
  }, []);

  // Self-heal: if we SSR'd the mock fallback, try once on the client in case
  // the backend came online after the server render.
  useEffect(() => {
    if (!initialLive) void refetch();
  }, [initialLive, refetch]);

  // Clean up flash timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
    };
  }, []);

  const flash = useCallback((id: string) => {
    setFlashing((prev) => new Set(prev).add(id));
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    timers.current.set(
      id,
      setTimeout(() => {
        setFlashing((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        timers.current.delete(id);
      }, 1400),
    );
  }, []);

  // Running a skill means starting a task GOVERNED by it (a skill needs a prompt
  // - mem_op 0.1). So open the New Task composer with this skill preselected;
  // the user provides the task there. The real usage bump + skill.loaded happen
  // when that run is submitted, not on this click.
  const onRun = useCallback(
    (skill: Skill) => {
      flash(skill.id);
      router.push(`/agent/new?skill=${encodeURIComponent(skill.id)}`);
    },
    [flash, router],
  );

  const groups = useMemo(() => groupSkills(skills), [skills]);

  const tags = useMemo(
    () => Array.from(new Set(skills.flatMap((s) => s.tags))).sort(),
    [skills],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups.filter((group) => {
      if (
        activeTag !== "all" &&
        !group.variants.some((s) => s.tags.includes(activeTag))
      ) {
        return false;
      }
      if (!q) return true;
      if (group.name.toLowerCase().includes(q)) return true;
      return group.variants.some(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.sourceRepo?.toLowerCase().includes(q) ||
          s.tags.some((tag) => tag.toLowerCase().includes(q)),
      );
    });
  }, [groups, query, activeTag]);

  // A narrower result set restarts the visible window.
  useEffect(() => {
    setLimit(SHOW_STEP);
  }, [query, activeTag]);

  // Resolve the open dialog from FRESH groups so a resync (new version, new
  // sha) is reflected immediately; a vanished group closes the dialog.
  const selectedGroup = useMemo<SkillGroup | null>(
    () => (selectedKey ? (groups.find((g) => g.key === selectedKey) ?? null) : null),
    [groups, selectedKey],
  );

  const filtering = query.trim().length > 0 || activeTag !== "all";

  return (
    <div className="mx-auto w-full max-w-[880px] px-6 py-8 sm:px-10 sm:py-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <RiFlashlightLine
              aria-hidden
              className="size-5 text-foreground-icon-primary"
            />
            <h1 className="text-title-2-medium text-text-primary">Skills</h1>
          </div>
          <p className="mt-1.5 text-body-2-regular text-text-secondary">
            Reusable skills useAgent follows for repeatable work
          </p>
        </div>
        <NewSkillModal onCreated={refetch} />
      </div>

      {error && skills.length === 0 ? (
        <BackendUnreachable className="mt-10" onRetry={refetch} />
      ) : (
        <>
          {/* Your skills */}
          <section className="mt-10">
            <div className="flex items-baseline gap-2">
              <h2 className="text-body-medium text-text-primary">Your skills</h2>
              <span className="text-caption-1-regular text-text-tertiary">
                {skills.length}
              </span>
            </div>

            {skills.length === 0 ? (
              <p className="mt-4 text-body-2-regular text-text-secondary">
                No skills yet. Capture one with New skill, or import from a
                repository below.
              </p>
            ) : (
              <>
                <div className="mt-4 flex flex-col gap-3">
                  <Input
                    aria-label="Search skills"
                    placeholder="Search skills..."
                    leadingIcon={RiSearchLine}
                    value={query}
                    onChange={setQuery}
                    className="max-w-[360px]"
                  />
                  {tags.length > 0 && (
                    <PillTabList aria-label="Filter skills by tag" className="flex flex-wrap">
                      <PillTab
                        variant="gray"
                        isSelected={activeTag === "all"}
                        onSelect={() => setActiveTag("all")}
                      >
                        All
                      </PillTab>
                      {tags.map((tag) => (
                        <PillTab
                          key={tag}
                          variant="gray"
                          isSelected={activeTag === tag}
                          onSelect={() => setActiveTag(tag)}
                        >
                          {tag}
                        </PillTab>
                      ))}
                    </PillTabList>
                  )}
                </div>

                {visible.length === 0 ? (
                  <p className="mt-6 text-body-2-regular text-text-secondary">
                    {filtering
                      ? "No skills match the current search."
                      : "No skills yet."}
                  </p>
                ) : (
                  <>
                    <SkillsList
                      className="mt-4"
                      groups={visible.length > limit ? visible.slice(0, limit) : visible}
                      onOpen={(group) => setSelectedKey(group.key)}
                      onRun={onRun}
                      flashing={flashing}
                    />
                    {visible.length > limit && (
                      <div className="mt-3 flex justify-center">
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={() => setLimit((prev) => prev + SHOW_STEP)}
                        >
                          Show more ({visible.length - limit} remaining)
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </section>

          <GithubImportSection onImported={refetch} />
        </>
      )}

      <SkillDetailDialog
        group={selectedGroup}
        onOpenChange={(open) => {
          if (!open) setSelectedKey(null);
        }}
        onRun={onRun}
        onChanged={refetch}
      />
    </div>
  );
}
