"use client";

import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiBookMarkedLine,
  RiLightbulbLine,
} from "@remixicon/react";
import Link from "next/link";
import { useCallback, useState } from "react";

import * as Badge from "@/components/ui/badge";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { relativeTime } from "@/utils/format";
import {
  acceptDraft,
  acceptProposal,
  dismissDraft,
  dismissProposal,
  fetchDrafts,
  fetchProposals,
  type KnowledgeDraft,
  type ProcedureTraceStep,
  type SkillProposal,
} from "./learnings-api";

/**
 * Learning review owner. Two human-governed queues over the learning lane:
 * knowledge drafts proposed from high-value runs, and skill revision proposals
 * assembled from repeated accepted drafts. Accept/Dismiss are org-admin
 * actions; nothing on this page auto-publishes anything.
 */
export function LearningReview({
  initialDrafts,
  initialProposals,
  initialError,
}: {
  initialDrafts: KnowledgeDraft[];
  initialProposals: SkillProposal[];
  initialError: boolean;
}) {
  const [drafts, setDrafts] = useState(initialDrafts);
  const [proposals, setProposals] = useState(initialProposals);
  const [error, setError] = useState(initialError);

  const refetch = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([fetchDrafts(), fetchProposals()]);
      setDrafts(d);
      setProposals(p);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  return (
    <div className="mx-auto w-full max-w-[880px] px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex items-start gap-2.5">
        <RiLightbulbLine aria-hidden className="mt-0.5 size-5 text-text-primary" />
        <div className="flex flex-col gap-0.5">
          <h1 className="text-display-sm text-text-primary">Learnings</h1>
          <p className="text-body-2-regular text-text-secondary">
            Review what useAgent proposes to learn. Nothing goes live without an accept.
          </p>
        </div>
      </div>

      {error ? (
        <BackendUnreachable className="mt-8" onRetry={refetch} />
      ) : (
        <>
          <section className="mt-8 flex flex-col gap-4">
            <SectionHeader
              icon={<RiLightbulbLine className="size-4 text-text-secondary" aria-hidden />}
              title="Knowledge drafts"
              count={drafts.length}
              hint="High-value completed runs propose these. Accepting publishes the draft into org knowledge; dismissing records the decision."
            />
            {drafts.length === 0 ? (
              <p className="text-body-2-regular text-text-secondary">
                No drafts yet. Completed runs that publish artifacts or use many
                tools propose learnings here.
              </p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {drafts.map((draft) => (
                  <DraftCard key={draft.id} draft={draft} onResolved={refetch} />
                ))}
              </div>
            )}
          </section>

          <div className="mt-10 border-t border-border-button-default" />

          <section className="mt-8 flex flex-col gap-4">
            <SectionHeader
              icon={<RiBookMarkedLine className="size-4 text-text-secondary" aria-hidden />}
              title="Skill proposals"
              count={proposals.length}
              hint="Repeated accepted learnings assemble into these. Accepting mints a real skill revision; dismissing records the decision."
            />
            {proposals.length === 0 ? (
              <p className="text-body-2-regular text-text-secondary">
                No proposals yet. They appear when several accepted learnings
                describe the same procedure.
              </p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {proposals.map((proposal) => (
                  <ProposalCard key={proposal.id} proposal={proposal} onResolved={refetch} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  count,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-body-2-medium text-text-secondary">{title}</h2>
        {count > 0 && <span className="text-caption-1-regular text-text-tertiary">{count}</span>}
      </div>
      <p className="text-caption-1-regular text-text-tertiary">{hint}</p>
    </div>
  );
}

const STATUS_META: Record<string, { label: string; color: "orange" | "green" | "gray" }> = {
  draft: { label: "Awaiting review", color: "orange" },
  proposed: { label: "Awaiting review", color: "orange" },
  accepted: { label: "Accepted", color: "green" },
  dismissed: { label: "Dismissed", color: "gray" },
};

/** Accept/Dismiss pill pair with busy + failure state (org-admin actions). */
function ResolveActions({
  onAccept,
  onDismiss,
}: {
  onAccept: () => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await fn();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => run(onAccept)}
        className="inline-flex items-center gap-1 rounded-full border border-border-button-default px-3 py-1 text-label-xs text-status-lime-text transition-colors hover:bg-background-secondary-default disabled:opacity-60"
      >
        Accept
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => run(onDismiss)}
        className="inline-flex items-center gap-1 rounded-full border border-border-button-default px-3 py-1 text-label-xs text-text-error-primary transition-colors hover:bg-background-secondary-default disabled:opacity-60"
      >
        Dismiss
      </button>
      {failure && <span className="text-caption-1-regular text-text-error-primary">{failure}</span>}
    </div>
  );
}

/** Small disclosure: renders its children only while open (lazy, cheap DOM). */
function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? RiArrowUpSLine : RiArrowDownSLine;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex w-fit items-center gap-1 text-label-xs text-text-secondary transition-colors hover:text-text-primary"
      >
        <Chevron className="size-3.5" aria-hidden />
        {label}
      </button>
      {open && children}
    </div>
  );
}

/** The run's ordered executable trace: what ran, against what, and whether it
 *  worked - the procedure a skill proposal is later assembled from. */
function ProcedureTraceList({
  steps,
  elided,
}: {
  steps: ProcedureTraceStep[];
  elided: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-mono-label text-text-tertiary">Procedure trace</p>
      <ol className="flex max-h-48 flex-col gap-0.5 overflow-auto">
        {steps.map((step, i) => (
          <li key={i} className="flex items-baseline gap-2 text-caption-1-regular">
            <span className="w-5 shrink-0 text-right [font-family:var(--font-mono)] text-text-tertiary">
              {i + 1}
            </span>
            <span className="shrink-0 [font-family:var(--font-mono)] text-text-primary">
              {step.tool}
            </span>
            <span className="min-w-0 truncate text-text-secondary">{step.gist}</span>
            {!step.ok && <span className="shrink-0 text-label-xs text-text-error-primary">failed</span>}
          </li>
        ))}
        {elided > 0 && (
          <li className="pl-7 text-caption-1-regular text-text-tertiary">
            ... {elided} more step{elided === 1 ? "" : "s"}
          </li>
        )}
      </ol>
    </div>
  );
}

function DraftCard({
  draft,
  onResolved,
}: {
  draft: KnowledgeDraft;
  onResolved: () => Promise<void>;
}) {
  const meta = STATUS_META[draft.status] ?? STATUS_META.dismissed!;
  const e = draft.evidence;
  return (
    <article className="flex flex-col gap-2 rounded-2xl bg-background-primary-default p-4 shadow-card ring-1 ring-inset ring-border-button-default">
      <div className="flex items-center gap-2">
        <Badge.Root variant="light" size="medium" color={meta.color}>
          {meta.label}
        </Badge.Root>
        <Link
          href={`/session/${draft.run_id}`}
          className="truncate text-caption-1-regular text-text-tertiary hover:text-text-secondary"
        >
          run {draft.run_id.slice(0, 8)}
        </Link>
        <span className="ml-auto text-caption-1-regular text-text-tertiary">
          {relativeTime(draft.created_at)}
        </span>
      </div>
      <p className="text-body-2-regular text-text-primary">{draft.title}</p>
      <Disclosure label="Evidence and proposed content">
        <div className="flex flex-col gap-2 rounded-xl bg-background-secondary-default p-3">
          <p className="text-caption-1-regular text-text-secondary">
            {e.reason === "published_artifacts"
              ? `Published ${e.artifactCount} artifact${e.artifactCount === 1 ? "" : "s"}`
              : "Long multi-tool run"}
            {" - "}
            {e.stepCount} steps, {e.distinctStepKinds} step kinds, {e.engine}/{e.model}
            {e.artifactNames.length > 0 ? ` - ${e.artifactNames.join(", ")}` : ""}
          </p>
          {e.procedure && e.procedure.length > 0 && (
            <ProcedureTraceList steps={e.procedure} elided={e.procedureElided ?? 0} />
          )}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap [font-family:var(--font-mono)] text-caption-1-regular text-text-secondary">
            {draft.content}
          </pre>
        </div>
      </Disclosure>
      {draft.status === "draft" && (
        <ResolveActions
          onAccept={async () => {
            await acceptDraft(draft.id);
            await onResolved();
          }}
          onDismiss={async () => {
            await dismissDraft(draft.id);
            await onResolved();
          }}
        />
      )}
    </article>
  );
}

function ProposalCard({
  proposal,
  onResolved,
}: {
  proposal: SkillProposal;
  onResolved: () => Promise<void>;
}) {
  const meta = STATUS_META[proposal.status] ?? STATUS_META.dismissed!;
  return (
    <article className="flex flex-col gap-2 rounded-2xl bg-background-primary-default p-4 shadow-card ring-1 ring-inset ring-border-button-default">
      <div className="flex items-center gap-2">
        <Badge.Root variant="light" size="medium" color={meta.color}>
          {meta.label}
        </Badge.Root>
        <Badge.Root variant="light" size="medium" color="blue">
          {proposal.skill_id ? "Revision" : "New playbook"}
        </Badge.Root>
        <span className="ml-auto text-caption-1-regular text-text-tertiary">
          {relativeTime(proposal.created_at)}
        </span>
      </div>
      <p className="text-body-2-regular text-text-primary">{proposal.name}</p>
      <p className="text-caption-1-regular text-text-tertiary">
        {proposal.description} Assembled from {proposal.source_draft_ids.length} accepted
        learnings.
      </p>
      <Disclosure label="Proposed SKILL.md">
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-background-secondary-default p-3 [font-family:var(--font-mono)] text-caption-1-regular text-text-secondary">
          {proposal.proposed_content}
        </pre>
      </Disclosure>
      {proposal.status === "proposed" && (
        <ResolveActions
          onAccept={async () => {
            await acceptProposal(proposal.id);
            await onResolved();
          }}
          onDismiss={async () => {
            await dismissProposal(proposal.id);
            await onResolved();
          }}
        />
      )}
    </article>
  );
}
