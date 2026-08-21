"use client";

import {
  RiBookMarkedLine,
  RiCheckLine,
  RiEditLine,
  RiPlayMiniLine,
} from "@remixicon/react";

import * as Badge from "@/components/ui/badge";
import * as Button from "@/components/ui/button";
import * as Modal from "@/components/ui/modal";
import { tagChipColor, usageCaption, type Skill } from "@/app/skills/skills-data";

/**
 * The detail view of one playbook: its Overview / Procedure / Verify content
 * rendered as read-only sections, with the version + usage caption and Edit /
 * Run actions. The copy is deliberately honest - useAgent FOLLOWS the procedure as
 * guidance; it is not a deterministic, step-by-step workflow engine.
 */

function OverviewList({ steps }: { steps: string[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {steps.map((step) => (
        <li key={step} className="flex gap-2.5 text-paragraph-sm text-text-sub-600">
          <span className="mt-2 size-1.5 shrink-0 rounded-full bg-text-soft-400" />
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
          <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md bg-bg-soft-200 font-mono text-subheading-2xs text-text-sub-600">
            {index + 1}
          </span>
          <span className="text-paragraph-sm text-text-sub-600">{step}</span>
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
          <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md bg-success-lighter text-success-base">
            <RiCheckLine className="size-3.5" aria-hidden />
          </span>
          <span className="text-paragraph-sm text-text-sub-600">{step}</span>
        </li>
      ))}
    </ul>
  );
}

const EMPTY = <p className="text-paragraph-sm text-text-soft-400">Not specified</p>;

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
      <p className="text-mono-label text-text-soft-400">{label}</p>
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
      <Modal.Content className="max-h-[90vh] max-w-[600px] overflow-y-auto">
        {playbook && (
          <div className="flex flex-col gap-6 p-6">
            <div className="flex items-start gap-4">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-stroke-soft-200 bg-bg-weak-50">
                <RiBookMarkedLine aria-hidden className="size-5 text-text-sub-600" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Modal.Title className="text-title-h6 text-text-strong-950">
                    {playbook.name}
                  </Modal.Title>
                  <Badge.Root variant="lighter" size="medium" color="purple">
                    Playbook
                  </Badge.Root>
                  <span className="font-mono text-label-xs tabular-nums text-text-soft-400">
                    v{playbook.version}
                  </span>
                </div>
                <Modal.Description className="mt-1 text-paragraph-sm text-text-sub-600">
                  {playbook.description}
                </Modal.Description>
                {playbook.tags.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {playbook.tags.map((tag) => (
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

            <div className="flex flex-col gap-6 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-5">
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

            <p className="text-paragraph-xs text-text-soft-400">
              useAgent follows this procedure as guidance when the playbook is
              attached to a run. It is not a fixed, step-by-step workflow - the
              agent applies judgement and the steps shape how it works.
            </p>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stroke-soft-200 pt-4">
              <p className="text-paragraph-xs text-text-sub-600">
                {usageCaption(playbook)}
              </p>
              <div className="flex items-center gap-2">
                <Button.Root
                  className="rounded-full"
                  variant="neutral"
                  mode="stroke"
                  size="small"
                  onClick={() => onEdit(playbook)}
                >
                  <Button.Icon as={RiEditLine} />
                  Edit
                </Button.Root>
                <Button.Root
                  className="rounded-full"
                  size="small"
                  onClick={() => onRun(playbook)}
                >
                  <Button.Icon as={RiPlayMiniLine} />
                  Run playbook
                </Button.Root>
              </div>
            </div>
          </div>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}
