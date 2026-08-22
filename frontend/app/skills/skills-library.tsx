"use client";

import { useMemo, useState } from "react";
import { RiCheckLine, RiPlayMiniLine } from "@remixicon/react";

import { Chip, type ChipProps } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/base/segmented-control/segmented-control";
import type { ChipColor } from "../knowledge/knowledge-data";
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

/** AlignUI badge hue (from the shared tag palette) → BoardUI Chip color. */
const CHIP_COLOR: Record<ChipColor, NonNullable<ChipProps["color"]>> = {
  gray: "gray",
  blue: "blue",
  orange: "yellow",
  red: "rose",
  green: "lime",
  yellow: "yellow",
  purple: "purple",
  sky: "cyan",
  pink: "rose",
  teal: "cyan",
};

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
    <article className="flex flex-col rounded-2xl bg-background-primary-default p-4 shadow-sm ring-1 ring-inset ring-border-button-default">
      <div className="flex size-9 items-center justify-center rounded-lg border border-border-button-default bg-background-secondary-default">
        <Icon aria-hidden className="size-5 text-foreground-icon-secondary" />
      </div>
      <h3 className="mt-3 text-body-2-medium text-text-primary">{skill.name}</h3>
      <p className="mt-1 text-caption-1-regular text-text-secondary">
        {skill.description}
      </p>
      {skill.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {skill.tags.map((tag) => (
            <Chip key={tag} variant="caption" color={CHIP_COLOR[tagChipColor(tag)]}>
              {tag}
            </Chip>
          ))}
        </div>
      )}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-separator-border pt-3">
        <p className="text-caption-1-regular text-text-tertiary">
          Used {skill.usageCount} {skill.usageCount === 1 ? "time" : "times"}
        </p>
        <Button
          variant="ghost"
          size="xs"
          className="rounded-full"
          leadingIcon={ran ? RiCheckLine : RiPlayMiniLine}
          onClick={() => onRun(skill)}
        >
          {ran ? "Ran" : "Run"}
        </Button>
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
      <SegmentedControl
        aria-label="Filter skills by tag"
        selectedKeys={[active]}
        onSelectionChange={(keys) => {
          const next = [...(keys as Set<string>)][0];
          if (next) setActive(next);
        }}
      >
        {filters.map(({ id, label }) => (
          <SegmentedControlItem key={id} id={id}>
            {label}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>

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
