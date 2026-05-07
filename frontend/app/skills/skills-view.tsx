"use client";

import { RiFlashlightLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { FeaturedSkill } from "./featured-skill";
import { NewSkillModal } from "./new-skill-modal";
import { fetchSkills } from "./skills-api";
import { pickFeatured, type Skill } from "./skills-data";
import { SkillsLibrary } from "./skills-library";

/**
 * Client owner for the Skills page: holds the skill list, hosts the "New skill"
 * modal, and wires the run action (optimistic usage bump + a check-flash
 * confirmation on the button). The highest-usage skill renders as the featured
 * card; the rest fill the library grid.
 */
export function SkillsView({
  initialSkills,
  initialLive,
}: {
  initialSkills: Skill[];
  initialLive: boolean;
}) {
  const router = useRouter();
  const [skills, setSkills] = useState<Skill[]>(initialSkills);
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const refetch = useCallback(async () => {
    try {
      const fresh = await fetchSkills();
      setSkills(fresh);
    } catch {
      // backend still unreachable — keep current list
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
  // — mem_op 0.1). So open the New Task composer with this playbook preselected;
  // the user provides the task there. The real usage bump + skill.loaded happen
  // when that run is submitted, not on this click.
  const onRun = useCallback(
    (skill: Skill) => {
      flash(skill.id);
      router.push(`/agent/new?skill=${encodeURIComponent(skill.id)}`);
    },
    [flash, router],
  );

  const featured = pickFeatured(skills);
  const librarySkills = featured
    ? skills.filter((s) => s.id !== featured.id)
    : skills;

  return (
    <div className="mx-auto w-full max-w-[1040px] px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <RiFlashlightLine
              aria-hidden
              className="size-5 text-text-strong-950"
            />
            <h1 className="text-display-sm text-text-strong-950">Skills</h1>
          </div>
          <p className="mt-1.5 text-paragraph-sm text-text-sub-600">
            Reusable playbooks Skynet follows for repeatable work
          </p>
        </div>
        <NewSkillModal onCreated={refetch} />
      </div>

      {skills.length === 0 ? (
        <p className="mt-10 text-paragraph-sm text-text-sub-600">
          No skills yet — capture your first playbook to get started.
        </p>
      ) : (
        <>
          {featured && (
            <div className="mt-8">
              <FeaturedSkill
                skill={featured}
                onRun={onRun}
                ran={flashing.has(featured.id)}
              />
            </div>
          )}

          {librarySkills.length > 0 && (
            <SkillsLibrary
              skills={librarySkills}
              onRun={onRun}
              flashing={flashing}
            />
          )}
        </>
      )}
    </div>
  );
}
