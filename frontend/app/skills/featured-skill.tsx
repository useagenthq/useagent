"use client";

import { RiCheckLine, RiFlashlightLine, RiPlayMiniLine } from "@remixicon/react";

import * as Badge from "@/components/ui/badge";
import * as Button from "@/components/ui/button";
import { tagChipColor, usageCaption, type Skill } from "./skills-data";

/**
 * The featured skill: one wide, fully-expanded skill card - title + "when to
 * use" line, then the skill body rendered as prose. Real SKILL.md files are
 * frontmatter + freeform markdown (Anthropic format), NOT a fixed Overview/
 * Procedure/Verify triptych, so we render whatever sections carry content as
 * flowing paragraphs. Empty sections simply do not appear (no dangling "—"
 * columns), and prose is never force-numbered (it was rendering paragraphs as
 * "steps 1..N", which read as nonsense - user report).
 */

const SECTION_LABELS: { key: keyof Skill["sections"]; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "procedure", label: "Procedure" },
  { key: "verify", label: "Verify" },
];

function SectionBlock({ label, lines }: { label: string; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-mono-label text-text-soft-400">{label}</p>
      <div className="text-paragraph-sm leading-6 text-text-sub-600 whitespace-pre-wrap">
        {lines.join("\n")}
      </div>
    </div>
  );
}

export function FeaturedSkill({
  skill,
  onRun,
  ran,
}: {
  skill: Skill;
  onRun: (skill: Skill) => void;
  ran: boolean;
}) {
  const populated = SECTION_LABELS.filter(({ key }) => skill.sections[key].length > 0);
  return (
    <article className="overflow-hidden rounded-2xl bg-bg-white-0 shadow-regular-sm ring-1 ring-inset ring-stroke-soft-200">
      <div className="flex flex-col gap-6 p-6 sm:p-7">
        <div className="flex items-start gap-4">
          <div className="relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl">
            <div className="absolute inset-0 bg-linear-135 from-purple-200 via-white to-sky-200" />
            <div className="absolute inset-0 bg-radial-[at_30%_28%] from-pink-300/70 from-0% to-transparent to-60%" />
            <RiFlashlightLine
              aria-hidden
              className="relative z-10 size-5 text-static-black"
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-title-h6 text-text-strong-950">
                {skill.name}
              </h2>
              <Badge.Root variant="lighter" size="medium" color="gray">
                Featured
              </Badge.Root>
            </div>
            <p className="mt-1 text-paragraph-sm text-text-sub-600">
              {skill.description}
            </p>
            {skill.tags.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
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
          </div>
        </div>

        {populated.length > 0 && (
          <div className="flex flex-col gap-5 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-5">
            {populated.map(({ key, label }) => (
              <SectionBlock key={key} label={label} lines={skill.sections[key]} />
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-paragraph-xs text-text-sub-600">
            {usageCaption(skill)}
          </p>
          <Button.Root className="rounded-full" size="small" onClick={() => onRun(skill)}>
            <Button.Icon as={ran ? RiCheckLine : RiPlayMiniLine} />
            {ran ? "Ran" : "Run skill"}
          </Button.Root>
        </div>
      </div>
    </article>
  );
}
