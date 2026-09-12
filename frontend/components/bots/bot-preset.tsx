"use client";

import { Fragment, useEffect, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import { type ApiBot, engineLabel, memoryScopeLabel } from "./types";

/**
 * The preset as labelled pairs: what the home thread was opened with and
 * cannot change afterwards. The model is not here on purpose: the composer
 * picks it per turn, and the thread header shows the current one.
 */
export function PresetSection({ bot }: { bot: ApiBot }) {
  const skillId = bot.skillIds[0] ?? null;
  const [skillName, setSkillName] = useState<string | null>(null);

  useEffect(() => {
    if (!skillId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await backendFetch(`/api/skills/${skillId}`);
        const data = response.ok ? ((await response.json()) as { name?: string }) : {};
        if (!cancelled) setSkillName(data.name ?? skillId);
      } catch {
        if (!cancelled) setSkillName(skillId);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [skillId]);

  const pairs: [string, string][] = [
    ["Engine", engineLabel(bot.engine)],
    ["Memory", memoryScopeLabel(bot.memoryScope)],
    ...(skillId ? [["Skill", skillName ?? "Loading"] as [string, string]] : []),
    ...(bot.repos.length > 0 ? [["Repos", bot.repos.join(", ")] as [string, string]] : []),
  ];

  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-body-2-medium text-text-primary">Preset</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-2-regular">
        {pairs.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-text-secondary">{label}</dt>
            <dd className="min-w-0 truncate text-text-primary" title={value}>
              {value}
            </dd>
          </Fragment>
        ))}
      </dl>
      {bot.presetLocked && (
        <p className="text-caption-1-regular text-text-tertiary">
          Fixed since the first message: the home thread runs on it.
        </p>
      )}
    </section>
  );
}
