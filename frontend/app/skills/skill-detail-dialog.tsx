"use client";

import { useEffect, useRef, useState } from "react";
import { RiPlayMiniLine, RiRefreshLine } from "@remixicon/react";

import { Chip, type ChipProps } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import * as Modal from "@/components/ui/modal";
import { fetchSkill, importSkillPaths } from "./skills-api";
import {
  sourceRepoLabel,
  tagChipColor,
  usageCaption,
  type Skill,
  type SkillGroup,
} from "./skills-data";
import type { ChipColor } from "../knowledge/knowledge-data";

/**
 * Detail view for one library row: the full (unclamped) description, the
 * instruction sections, and per-variant provenance + actions. A row grouping
 * several records (the same skill imported from different sources) lists every
 * variant with its own source, version, usage and Run button - the grouping
 * consolidates presentation, it never hides a record. Imported variants also
 * get "Resync from source": the same source-keyed import upsert the backend
 * uses (unchanged content is a no-op). The Modal shell stays the sanctioned
 * dialog layer; its visible surfaces are BoardUI tokens.
 *
 * The library list is section-free (view=library), so each opened variant
 * loads its full record once via GET /api/skills/:id, cached per (id, version)
 * - a resync that mints a new version invalidates naturally.
 */

/** Shared tag palette (knowledge ChipColor) → base Chip color. */
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

const SECTION_LABELS = ["Overview", "Procedure", "Verify"] as const;

type ResyncState =
  | { status: "syncing" }
  | { status: "done"; message: string }
  | { status: "error"; message: string };

function resyncMessage(action: string, version?: number): string {
  switch (action) {
    case "updated":
      return version ? `Updated to v${version}` : "Updated from source";
    case "created":
      return "Imported from source";
    case "unchanged":
      return "Already up to date";
    case "protected":
      return "Protected skill - resync is disabled";
    default:
      return "Source file not found at the repo HEAD";
  }
}

/** The full record for a variant: loading until fetched, then the skill (with
 *  sections) or an error marker. Keyed by (id, version) in the dialog cache. */
type VariantDetail = Skill | "loading" | "error";

function detailKey(skill: Skill): string {
  return `${skill.id}@${skill.version}`;
}

function SkillSections({ detail }: { detail: VariantDetail }) {
  if (detail === "loading") {
    return (
      <p className="text-caption-1-regular text-text-tertiary">
        Loading instructions...
      </p>
    );
  }
  if (detail === "error") {
    return (
      <p className="text-caption-1-regular text-text-error-primary">
        Could not load the full instructions. Check the backend and try again.
      </p>
    );
  }
  const lists = [
    detail.sections.overview,
    detail.sections.procedure,
    detail.sections.verify,
  ];
  if (lists.every((steps) => steps.length === 0)) return null;
  return (
    <div className="flex flex-col gap-5 rounded-xl bg-background-secondary-default p-4">
      {SECTION_LABELS.map((label, index) =>
        lists[index].length === 0 ? null : (
          <div key={label} className="flex flex-col gap-2">
            <p className="text-mono-label text-text-tertiary">{label}</p>
            <ul className="flex flex-col gap-1.5">
              {lists[index].map((step, stepIndex) => (
                <li
                  key={`${stepIndex}-${step.slice(0, 40)}`}
                  className="break-words text-body-2-regular text-text-secondary"
                >
                  {step}
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </div>
  );
}

function VariantBlock({
  skill,
  detail,
  multi,
  onRun,
  resync,
  onResync,
}: {
  skill: Skill;
  detail: VariantDetail;
  multi: boolean;
  onRun: (skill: Skill) => void;
  resync: ResyncState | undefined;
  onResync: (skill: Skill) => void;
}) {
  const imported = Boolean(skill.sourceRepo && skill.sourcePath);
  const syncing = resync?.status === "syncing";
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {multi && imported && (
          <Chip variant="caption" color="soft">
            {sourceRepoLabel(skill)}
          </Chip>
        )}
        <span className="font-mono text-caption-1-medium tabular-nums text-text-tertiary">
          v{skill.version}
        </span>
        <span className="text-caption-1-regular text-text-tertiary">
          {usageCaption(skill)}
        </span>
      </div>

      <p className="text-caption-1-regular text-text-tertiary">
        {imported ? (
          <>
            Imported from{" "}
            <span className="font-mono text-text-secondary">
              {skill.sourceRepo} · {skill.sourcePath}
            </span>
            {skill.sourceSha ? (
              <span> · synced at {skill.sourceSha.slice(0, 7)}</span>
            ) : null}
          </>
        ) : (
          "Created in useAgent"
        )}
      </p>

      {skill.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {skill.tags.map((tag) => (
            <Chip key={tag} variant="caption" color={CHIP_COLOR[tagChipColor(tag)]}>
              {tag}
            </Chip>
          ))}
        </div>
      )}

      {/* In a grouped row each variant shows its own full description - the
          variants are distinct records and may genuinely differ. */}
      {multi && skill.description.trim() && (
        <p className="whitespace-pre-wrap break-words text-body-2-regular text-text-secondary">
          {skill.description}
        </p>
      )}

      <SkillSections detail={detail} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="small"
          leadingIcon={RiPlayMiniLine}
          onClick={() => onRun(skill)}
        >
          Run
        </Button>
        {imported && (
          <Button
            variant="secondary"
            size="small"
            leadingIcon={RiRefreshLine}
            disabled={syncing}
            onClick={() => onResync(skill)}
          >
            {syncing ? "Resyncing..." : "Resync from source"}
          </Button>
        )}
        {resync && resync.status !== "syncing" && (
          <span
            className={
              resync.status === "error"
                ? "text-caption-1-regular text-text-error-primary"
                : "text-caption-1-regular text-text-tertiary"
            }
          >
            {resync.message}
          </span>
        )}
      </div>
    </section>
  );
}

export function SkillDetailDialog({
  group,
  onOpenChange,
  onRun,
  onChanged,
}: {
  /** The row being inspected; null renders nothing (dialog closed). */
  group: SkillGroup | null;
  onOpenChange: (open: boolean) => void;
  onRun: (skill: Skill) => void;
  /** A resync changed real data - refetch the library. */
  onChanged: () => void | Promise<void>;
}) {
  const [resyncById, setResyncById] = useState<Record<string, ResyncState>>({});
  // Full records per (id, version). A resync bumps the version, which is a new
  // key - stale sections never linger. `requested` dedupes in-flight fetches
  // (same pattern as the composer's branch probe).
  const [details, setDetails] = useState<Record<string, Skill | "error">>({});
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!group) return;
    let cancelled = false;
    for (const variant of group.variants) {
      const key = detailKey(variant);
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      void fetchSkill(variant.id).then(
        (full) => {
          if (!cancelled) setDetails((prev) => ({ ...prev, [key]: full }));
        },
        () => {
          // Allow a retry on the next open instead of pinning the error.
          requested.current.delete(key);
          if (!cancelled) setDetails((prev) => ({ ...prev, [key]: "error" }));
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [group]);

  const onResync = async (skill: Skill) => {
    if (!skill.sourceRepo || !skill.sourcePath) return;
    setResyncById((prev) => ({ ...prev, [skill.id]: { status: "syncing" } }));
    try {
      const { results } = await importSkillPaths(skill.sourceRepo, [skill.sourcePath]);
      const outcome = results[0];
      const message = outcome
        ? resyncMessage(outcome.action, outcome.version)
        : "No result returned";
      setResyncById((prev) => ({ ...prev, [skill.id]: { status: "done", message } }));
      if (outcome && (outcome.action === "created" || outcome.action === "updated")) {
        await onChanged();
      }
    } catch (error) {
      // A 403 means the source repo is no longer available to this org - a
      // different situation from the backend being down.
      const message =
        error instanceof Error && error.message.endsWith("403")
          ? "Resync failed - the source repository is not available to this organization."
          : "Resync failed. Check the backend and try again.";
      setResyncById((prev) => ({
        ...prev,
        [skill.id]: { status: "error", message },
      }));
    }
  };

  const multi = (group?.variants.length ?? 0) > 1;

  return (
    <Modal.Root
      open={group !== null}
      onOpenChange={(next) => {
        if (!next) setResyncById({});
        onOpenChange(next);
      }}
    >
      <Modal.Content className="max-h-[85vh] max-w-[600px] overflow-y-auto rounded-3xl border border-border-button-default bg-background-primary-default shadow-dropdown">
        {group && (
          <div className="flex flex-col gap-5 p-6">
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Modal.Title className="text-title-3-medium text-text-primary">
                  {group.name}
                </Modal.Title>
                {multi && (
                  <Chip variant="caption" color="soft">
                    {group.variants.length} sources
                  </Chip>
                )}
              </div>
              <Modal.Description
                className={
                  multi
                    ? "text-body-2-regular text-text-tertiary"
                    : "whitespace-pre-wrap break-words text-body-2-regular text-text-secondary"
                }
              >
                {multi
                  ? "This name was imported from more than one source. Each record below is distinct - run or resync them individually."
                  : group.variants[0].description || "No description."}
              </Modal.Description>
            </div>

            {group.variants.map((skill, index) => (
              <div key={skill.id} className="flex flex-col gap-5">
                {index > 0 && <div className="h-px bg-separator-border" />}
                <VariantBlock
                  skill={skill}
                  detail={details[detailKey(skill)] ?? "loading"}
                  multi={multi}
                  onRun={onRun}
                  resync={resyncById[skill.id]}
                  onResync={onResync}
                />
              </div>
            ))}
          </div>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}
