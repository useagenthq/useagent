"use client";

import { useMemo, useState } from "react";
import { RiCheckLine, RiPlayMiniLine } from "@remixicon/react";

import * as Badge from "@/components/ui/badge";
import * as Button from "@/components/ui/button";
import * as SegmentedControl from "@/components/ui/segmented-control";
import {
  skillIconIndex,
  skillIconPool,
  tagChipColor,
  type Skill,
} from "./skills-data";

/**
 * The library: a client-filtered grid of compact skill cards. Each card is the
 * collapsed form of the featured skill - icon tile, name, one-line summary,
 * tag chips and a run action — so the whole surface reads as one library of the
 * same object at two densities. Tag filters are derived from the real data.
 */

function SkillCard({
  skill,
  onRun,
  ran,
}: {
  skill: Skill;
  onRun: (skill: Skill) => void;
  ran: boolean;
}) {
  const Icon = skillIconPool[skillIconIndex(skill)];
  return (
    <article className="flex flex-col rounded-2xl bg-bg-white-0 p-4 shadow-regular-sm ring-1 ring-inset ring-stroke-soft-200">
      <div className="flex size-9 items-center justify-center rounded-lg border border-stroke-soft-200 bg-bg-weak-50">
        <Icon aria-hidden className="size-5 text-text-sub-600" />
      </div>
      <h3 className="mt-3 text-label-sm text-text-strong-950">{skill.name}</h3>
      <p className="mt-1 text-paragraph-xs text-text-sub-600">
        {skill.description}
      </p>
      {skill.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {skill.tags.map((tag) => (
            <Badge.Root
              key={tag}
              variant="light"
              size="medium"
              color={tagChipColor(tag)}
            >
              {tag}
            </Badge.Root>
          ))}
        </div>
      )}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-stroke-soft-200 pt-3">
        <p className="text-paragraph-xs text-text-soft-400">
          Used {skill.usageCount} {skill.usageCount === 1 ? "time" : "times"}
        </p>
        <Button.Root className="rounded-full"
          variant="neutral"
          mode="ghost"
          size="xsmall"
          onClick={() => onRun(skill)}
        >
          <Button.Icon as={ran ? RiCheckLine : RiPlayMiniLine} />
          {ran ? "Ran" : "Run"}
        </Button.Root>
      </div>
    </article>
  );
}

export function SkillsLibrary({
  skills,
  onRun,
  flashing,
}: {
  skills: Skill[];
  onRun: (skill: Skill) => void;
  flashing: ReadonlySet<string>;
}) {
  const [active, setActive] = useState<string>("all");

  const filters = useMemo(() => {
    const tags = Array.from(new Set(skills.flatMap((s) => s.tags))).sort();
    return [
      { id: "all", label: "All" },
      ...tags.map((t) => ({ id: t, label: t })),
    ];
  }, [skills]);

  const visible = useMemo(
    () =>
      active === "all"
        ? skills
        : skills.filter((skill) => skill.tags.includes(active)),
    [active, skills],
  );

  return (
    <section className="mt-8">
      <SegmentedControl.Root value={active} onValueChange={setActive}>
        <SegmentedControl.List aria-label="Filter skills by tag">
          {filters.map(({ id, label }) => (
            <SegmentedControl.Trigger key={id} value={id}>
              {label}
            </SegmentedControl.Trigger>
          ))}
        </SegmentedControl.List>
      </SegmentedControl.Root>

      <div className="mt-5 grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            onRun={onRun}
            ran={flashing.has(skill.id)}
          />
        ))}
      </div>
    </section>
  );
}
