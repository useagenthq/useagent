"use client";

import {
  RiBookMarkedLine,
  RiCheckLine,
  RiEditLine,
  RiPlayMiniLine,
} from "@remixicon/react";

import { Chip, type ChipProps } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import * as Modal from "@/components/ui/modal";
import { tagChipColor, usageCaption, type Skill } from "@/app/skills/skills-data";
import type { ChipColor } from "@/app/knowledge/knowledge-data";
import { CHIP_COLOR } from "@/components/foundations/form-recipes";

/**
 * The detail view of one playbook: its Overview / Procedure / Verify content
 * rendered as read-only sections (the step markers are semantic - bullet,
 * numbered, check), with the version + usage caption and Edit / Run actions.
 * The full description lives here; the list row clamps it. The copy is
 * deliberately honest - useAgent FOLLOWS the procedure as guidance; it is not a
 * deterministic, step-by-step workflow engine. The Modal shell stays AlignUI
 * (no BoardUI equivalent); its visible surfaces are BoardUI tokens.
 */

function OverviewList({ steps }: { steps: string[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {steps.map((step) => (
        <li key={step} className="flex gap-2.5 text-body-2-regular text-text-secondary">
          <span className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground-icon-tertiary" />
          <span>{step}</span>
        </li>
      ))}
    </ul>
  );
}

function ProcedureList({ steps }: { steps: string[] }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {steps.map((step, index) => (
        <li key={step} className="flex gap-2.5">
          <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md bg-background-tertiary-default font-mono text-caption-2-medium text-text-secondary">
            {index + 1}
          </span>
          <span className="text-body-2-regular text-text-secondary">{step}</span>
        </li>
      ))}
    </ol>
  );
}

function VerifyList({ steps }: { steps: string[] }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {steps.map((step) => (
        <li key={step} className="flex gap-2.5">
          <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md bg-status-lime-background text-status-lime-text">
            <RiCheckLine className="size-3.5" aria-hidden />
          </span>
          <span className="text-body-2-regular text-text-secondary">{step}</span>
        </li>
      ))}
    </ul>
  );
}

const EMPTY = <p className="text-body-2-regular text-text-tertiary">Not specified</p>;

function Section({
  label,
  children,
  empty,
}: {
  label: string;
  children: React.ReactNode;
  empty: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-mono-label text-text-tertiary">{label}</p>
      {empty ? EMPTY : children}
    </div>
  );
}

export function PlaybookDetail({
  open,
  onOpenChange,
  playbook,
  onEdit,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playbook: Skill | null;
  onEdit: (playbook: Skill) => void;
  onRun: (playbook: Skill) => void;
}) {
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content className="max-h-[90vh] max-w-[600px] overflow-y-auto rounded-3xl border border-border-button-default bg-background-primary-default shadow-dropdown">
        {playbook && (
          <div className="flex flex-col gap-6 p-6">
            <div className="flex items-start gap-3">
              <RiBookMarkedLine
                aria-hidden
                className="mt-1 size-5 shrink-0 text-foreground-icon-secondary"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Modal.Title className="text-title-3-medium text-text-primary">
                    {playbook.name}
                  </Modal.Title>
                  <span className="font-mono text-caption-1-medium tabular-nums text-text-tertiary">
                    v{playbook.version}
                  </span>
                </div>
                <Modal.Description className="mt-1 text-body-2-regular text-text-secondary">
                  {playbook.description}
                </Modal.Description>
                {playbook.tags.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {playbook.tags.map((tag) => (
                      <Chip
                        key={tag}
                        variant="caption"
                        color={CHIP_COLOR[tagChipColor(tag)]}
                      >
                        {tag}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-6 rounded-xl border border-border-button-default bg-background-secondary-default p-5">
              <Section label="Overview" empty={playbook.sections.overview.length === 0}>
                <OverviewList steps={playbook.sections.overview} />
              </Section>
              <Section label="Procedure" empty={playbook.sections.procedure.length === 0}>
                <ProcedureList steps={playbook.sections.procedure} />
              </Section>
              <Section label="Verify" empty={playbook.sections.verify.length === 0}>
                <VerifyList steps={playbook.sections.verify} />
              </Section>
            </div>

            <p className="text-caption-1-regular text-text-tertiary">
              useAgent follows this procedure as guidance when the playbook is
              attached to a run. It is not a fixed, step-by-step workflow - the
              agent applies judgement and the steps shape how it works.
            </p>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-separator-border pt-4">
              <p className="text-caption-1-regular text-text-secondary">
                {usageCaption(playbook)}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  leadingIcon={RiEditLine}
                  onClick={() => onEdit(playbook)}
                >
                  Edit
                </Button>
                <Button
                  variant="primary"
                  size="small"
                  leadingIcon={RiPlayMiniLine}
                  onClick={() => onRun(playbook)}
                >
                  Run playbook
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}
