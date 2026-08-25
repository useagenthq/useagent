"use client";

import { memo } from "react";
import { RiCheckLine, RiPlayMiniLine } from "@remixicon/react";

import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { visibleDescription } from "@/components/customize/list-row";
import { cx } from "@/utils/cx";
import { sourceRepoLabel, type Skill, type SkillGroup } from "./skills-data";

/**
 * The library list: one compact row per skill NAME (variants imported from
 * different sources are grouped into the row - see groupSkills). Strict
 * hierarchy per row: body-medium name + source chips, then ONE truncated
 * caption line (source repo + description); usage stat and a single action on
 * the right. Full descriptions and per-source detail live behind the detail
 * dialog. Rows are memo'd, fixed-height, and hover changes background color
 * only - no layout shift, no per-row motion.
 */

function groupUsageCount(group: SkillGroup): number {
  return group.variants.reduce((sum, skill) => sum + skill.usageCount, 0);
}

/** Distinct short repo labels across a group's variants, in variant order. */
function groupSourceLabels(group: SkillGroup): string[] {
  const labels: string[] = [];
  for (const variant of group.variants) {
    const label = sourceRepoLabel(variant);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

const SkillRow = memo(function SkillRow({
  group,
  onOpen,
  onRun,
  ran,
}: {
  group: SkillGroup;
  onOpen: (group: SkillGroup) => void;
  onRun: (skill: Skill) => void;
  ran: boolean;
}) {
  const primary = group.variants[0];
  const multi = group.variants.length > 1;
  const uses = groupUsageCount(group);
  // Drop a description that only restates the skill name (common in imported
  // SKILL.md frontmatter) so the caption carries source/real detail, not an echo.
  const description = visibleDescription(group.name, primary.description) ?? "";
  // One caption line, always present, truncated - stable two-line rows. For a
  // grouped row the source chips carry the repos, so the caption is just the
  // description; a single imported skill leads with its "owner/repo".
  const caption = multi
    ? description || `${group.variants.length} sources`
    : primary.sourceRepo
      ? description
        ? `${primary.sourceRepo} · ${description}`
        : primary.sourceRepo
      : description || "Created in useAgent";

  return (
    <li className="group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-background-primary-hover">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {/* Stretched click target: the name button opens the detail view for
              the whole row surface; the Run button sits above it (z-10). */}
          <button
            type="button"
            onClick={() => onOpen(group)}
            className="min-w-0 cursor-pointer truncate rounded-xs text-left text-body-medium text-text-primary outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            {group.name}
          </button>
          {multi &&
            groupSourceLabels(group).map((label) => (
              <Chip key={label} variant="caption" color="soft" className="shrink-0">
                {label}
              </Chip>
            ))}
        </div>
        <p className="mt-0.5 truncate text-caption-1-regular text-text-tertiary">
          {caption}
        </p>
      </div>
      <span className="hidden shrink-0 text-caption-1-regular text-text-tertiary sm:block">
        {uses > 0 ? `Used ${uses} ${uses === 1 ? "time" : "times"}` : "Unused"}
      </span>
      {multi ? (
        <Button
          variant="ghost"
          size="xs"
          className="relative z-10 shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => onOpen(group)}
        >
          View
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="xs"
          className="relative z-10 shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          leadingIcon={ran ? RiCheckLine : RiPlayMiniLine}
          onClick={() => onRun(primary)}
        >
          {ran ? "Ran" : "Run"}
        </Button>
      )}
    </li>
  );
});

export function SkillsList({
  groups,
  onOpen,
  onRun,
  flashing,
  className,
}: {
  groups: SkillGroup[];
  onOpen: (group: SkillGroup) => void;
  onRun: (skill: Skill) => void;
  flashing: ReadonlySet<string>;
  className?: string;
}) {
  return (
    <ul
      className={cx(
        "divide-y divide-separator-border overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-xs",
        className,
      )}
    >
      {groups.map((group) => (
        <SkillRow
          key={group.key}
          group={group}
          onOpen={onOpen}
          onRun={onRun}
          ran={group.variants.some((skill) => flashing.has(skill.id))}
        />
      ))}
    </ul>
  );
}
