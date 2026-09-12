"use client";

// The conversation's inline subagent group: ONE quiet fold per turn ("N
// subagents") whose per-child rows read the SAME merged children projection as
// the Agents rail (`deriveChildrenView` - one derivation, two surfaces), plus
// this turn's gateway child sessions (runs the agent spawned through
// child_session_create). Gateway children are QUEUED SERIAL thread turns - each
// row states its own queued/running/settled status; nothing here implies
// parallel execution. Timeline grammar: plain glyphs, BoardUI tokens, no motion
// wrappers on the list (matches the context-recall fold shell).

import { RiArrowDownSLine, RiExternalLinkLine, RiRobot2Line } from "@remixicon/react";
import type {
  ExecutionSummarySnapshot,
  ProductThreadStatus,
  ThreadRelationship,
} from "@useagent/agent-client";
import Link from "next/link";
import { useMemo } from "react";
import { childStatusLabel, isChildActive } from "@/components/chat/agent-status";
import type { MergedChildFidelity } from "@/components/chat/canonical-children";
import { type ChildKind, childGroupLabel, childKindLabel } from "@/components/chat/child-labels";
import type { CanonicalEventLike } from "@/components/chat/canonical-timeline";
import { deriveChildrenViewFromExecutionSummary } from "@/components/chat/execution-summary-rollout";
import {
  firstLine,
  type GatewayChildSession,
  RUN_CHILD_STATUS,
  RUN_STATUS_LABEL,
} from "@/components/chat/gateway-children";
import type { ChildStatus, NativeFrame } from "@/components/chat/native-events";
import type { SubagentCard } from "@/components/chat/subagents";
import { useTurnUiState } from "@/components/chat/turn-ui-state";
import type { ApiStep } from "@/components/chat/types";
import {
  CHILD_META_CLASS,
  formatChildEngineModel,
  formatSubagentTokenCount,
  STATUS_TONE,
} from "@/components/session-ui/agent-panel-row";
import { StatusDot } from "@/components/shared/status-dot";
import { cx as cn } from "@/utils/cx";

// GatewayChildSession + its status maps live in ./gateway-children (shared with
// the Agents rail); re-exported here so existing importers (conversation, tests)
// keep resolving the type from this module.
export type { GatewayChildSession } from "./gateway-children";

const ROW_LINK_CLASS =
  "text-text-tertiary hover:bg-background-primary-hover hover:text-text-secondary mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring";

function NativeChildRow({
  card,
  fidelity,
  runLive,
}: {
  card: SubagentCard;
  fidelity: MergedChildFidelity | undefined;
  runLive: boolean;
}) {
  const status = fidelity?.status ?? (runLive ? "running" : "completed");
  const active = isChildActive(status);
  const meta = [
    formatChildEngineModel(null, fidelity?.model),
    fidelity?.usage ? `${formatSubagentTokenCount(fidelity.usage.totalTokens)} tok` : null,
  ].filter((value): value is string => value !== null);
  const state = active
    ? (fidelity?.progress ?? card.status ?? "Working")
    : (fidelity?.resultText ??
      card.status ??
      childStatusLabel(status, fidelity?.resumable ?? null));

  return (
    <li className="flex items-start gap-2 px-1.5 py-1" data-testid="subagent-fold-row">
      <StatusDot tone={STATUS_TONE[status]} pulse={active} className="mt-1" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-body-2-medium text-text-primary min-w-0 truncate">
            {card.title}
          </span>
          {fidelity?.role && (
            <span className="border-border-button-default text-text-tertiary max-w-28 shrink-0 truncate rounded-full border px-1.5 text-caption-2-medium">
              {fidelity.role}
            </span>
          )}
          {meta.length > 0 && (
            <span className={cn(CHILD_META_CLASS, "ml-auto shrink-0")}>{meta.join(" · ")}</span>
          )}
        </div>
        <p className="text-caption-1-regular text-text-tertiary truncate">
          {firstLine(state)}
        </p>
      </div>
    </li>
  );
}

function GatewayChildRow({ child }: { child: GatewayChildSession }) {
  const status = RUN_CHILD_STATUS[child.status];
  const active = isChildActive(status);
  const state = [
    RUN_STATUS_LABEL[child.status],
    child.summary ? firstLine(child.summary) : null,
  ]
    .filter((value): value is string => value !== null && value.length > 0)
    .join(" · ");

  return (
    <li className="flex items-start gap-2 px-1.5 py-1" data-testid="subagent-fold-row">
      <StatusDot
        tone={STATUS_TONE[status]}
        hollow={child.status === "queued"}
        pulse={active}
        className="mt-1"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-body-2-medium text-text-primary min-w-0 truncate">
            {child.prompt}
          </span>
          <span className="text-caption-1-regular text-text-tertiary shrink-0 max-sm:hidden">
            {childKindLabel("spawned_session")}
          </span>
          <span className={cn(CHILD_META_CLASS, "ml-auto shrink-0")}>
            {formatChildEngineModel(child.engine, child.model)}
          </span>
        </div>
        <p className="text-caption-1-regular text-text-tertiary truncate">{state}</p>
      </div>
      <Link
        href={`/session/${child.id}`}
        aria-label={`Open spawned session: ${firstLine(child.prompt)}`}
        title="Open as its own thread"
        className={ROW_LINK_CLASS}
      >
        <RiExternalLinkLine className="size-3.5" aria-hidden />
      </Link>
    </li>
  );
}

const PRODUCT_CHILD_STATUS: Record<ProductThreadStatus, ChildStatus> = {
  queued: "pending",
  waiting: "waiting",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

function ProductChildRow({
  child,
  onOpen,
}: {
  child: ThreadRelationship;
  onOpen?: (threadId: string) => void;
}) {
  const status = PRODUCT_CHILD_STATUS[child.status];
  const active = isChildActive(status);
  const kind: ChildKind = child.bot ? "bot_thread" : "child_thread";
  const statusLabel = childStatusLabel(status);
  // A settled row that did not succeed says so in words, not just in the dot's
  // colour: "Failed · <summary>".
  const state = child.latestSummary
    ? !active && status !== "completed"
      ? `${statusLabel} · ${firstLine(child.latestSummary)}`
      : firstLine(child.latestSummary)
    : statusLabel;
  return (
    <li className="flex items-start gap-2 px-1.5 py-1" data-testid="subagent-fold-row">
      <button
        type="button"
        onClick={() => onOpen?.(child.threadId)}
        aria-label={`Inspect ${childKindLabel(kind)}: ${child.title}`}
        className="hover:bg-background-primary-hover -mx-1.5 -my-1 flex min-w-0 flex-1 items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
      >
        <StatusDot
          tone={STATUS_TONE[status]}
          pulse={active}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-body-2-medium text-text-primary min-w-0 truncate">
              {child.title}
            </span>
            {/* Hidden at phone width so the title keeps its room; the fold
                header and the row's accessible name still carry the kind. */}
            <span className="text-caption-1-regular text-text-tertiary max-w-40 shrink-0 truncate max-sm:hidden">
              {childKindLabel(kind, child.bot?.name)}
            </span>
            <span className={cn(CHILD_META_CLASS, "ml-auto shrink-0")}>
              {formatChildEngineModel(child.engine, child.model)}
            </span>
          </div>
          <p
            className={cn(
              "text-caption-1-regular truncate",
              status === "failed" ? "text-text-error-primary" : "text-text-tertiary",
            )}
          >
            {state}
          </p>
          <span className="sr-only">{statusLabel}</span>
        </div>
      </button>
      <Link
        href={`/session/${child.threadId}`}
        aria-label={`Open ${childKindLabel(kind)}: ${child.title}`}
        title="Open as its own thread"
        className={ROW_LINK_CLASS}
      >
        <RiExternalLinkLine className="size-3.5" aria-hidden />
      </Link>
    </li>
  );
}

function ProductChildResults({ children }: { children: readonly ThreadRelationship[] }) {
  const settled = children.filter(
    (child) => !isChildActive(PRODUCT_CHILD_STATUS[child.status]) && child.latestSummary?.trim(),
  );
  if (children.length < 2 || settled.length !== children.length) return null;

  return (
    <li
      className="mt-3 px-2"
      data-testid="product-child-results"
    >
      <p className="text-caption-1-medium text-text-secondary">Combined results</p>
      <div className="mt-2 space-y-3">
        {settled.map((child) => (
          <div key={child.threadId}>
            <p className="text-body-2-medium text-text-primary">
              {child.title}
              {child.status === "completed" ? "" : ` · ${childStatusLabel(PRODUCT_CHILD_STATUS[child.status])}`}
            </p>
            <p className="text-body-2-regular text-text-secondary mt-0.5 whitespace-pre-wrap">
              {child.latestSummary}
            </p>
          </div>
        ))}
      </div>
    </li>
  );
}

/**
 * "N subagents" fold for one conversation turn. Renders nothing when the turn
 * spawned no children. Open by default while any child is still active (the
 * fold is the live signal), collapsed once everything settled; the user's
 * toggle always wins afterwards.
 */
export function SubagentsFold({
  steps,
  frames = [],
  canonicalEvents = [],
  executionSummary = null,
  live,
  childSessions = [],
  productChildren = [],
  onOpenProductChild,
}: {
  steps: readonly ApiStep[];
  frames?: readonly NativeFrame[];
  canonicalEvents?: readonly CanonicalEventLike[];
  executionSummary?: ExecutionSummarySnapshot | null;
  /** The parent turn's liveness - the status fallback for children without a
   *  native/canonical status frame (same rule as the Agents rail). */
  live: boolean;
  childSessions?: readonly GatewayChildSession[];
  productChildren?: readonly ThreadRelationship[];
  onOpenProductChild?: (threadId: string) => void;
}) {
  const view = useMemo(
    () => deriveChildrenViewFromExecutionSummary(steps, frames, canonicalEvents, executionSummary),
    [steps, frames, canonicalEvents, executionSummary],
  );
  const [toggled, setToggled] = useTurnUiState<boolean | null>("subagents", null);

  const count = view.cards.length + childSessions.length + productChildren.length;
  if (count === 0) return null;
  const botThreads = productChildren.filter((child) => child.bot !== null).length;
  const label = childGroupLabel({
    subagent: view.cards.length,
    bot_thread: botThreads,
    child_thread: productChildren.length - botThreads,
    spawned_session: childSessions.length,
  });

  const runLive = live && !steps.some((s) => s.kind === "done");
  const fidelityFor = (card: SubagentCard): MergedChildFidelity | undefined => {
    for (const alias of card.aliases) {
      const match = view.fidelity.get(alias);
      if (match) return match;
    }
    return undefined;
  };
  const anyActive =
    childSessions.some((child) => isChildActive(RUN_CHILD_STATUS[child.status])) ||
    productChildren.some((child) => isChildActive(PRODUCT_CHILD_STATUS[child.status])) ||
    (runLive &&
      view.cards.some((card) => {
        const status = fidelityFor(card)?.status ?? "running";
        return isChildActive(status);
      }));
  const open = toggled ?? (anyActive || productChildren.length > 0);

  return (
    <section data-testid="subagents-fold">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setToggled(!open)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-background-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
      >
        <RiRobot2Line className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-body-2-medium font-medium text-text-secondary">{label}</span>
        </span>
        <RiArrowDownSLine
          className={cn(
            "size-4 shrink-0 text-text-tertiary transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open && (
        <ul className="mt-0.5 space-y-px">
          {view.cards.map((card) => (
            <NativeChildRow
              key={card.id}
              card={card}
              fidelity={fidelityFor(card)}
              runLive={runLive}
            />
          ))}
          {childSessions.map((child) => (
            <GatewayChildRow key={child.id} child={child} />
          ))}
          {productChildren.map((child) => (
            <ProductChildRow
              key={child.threadId}
              child={child}
              onOpen={onOpenProductChild}
            />
          ))}
          <ProductChildResults children={productChildren} />
        </ul>
      )}
    </section>
  );
}
