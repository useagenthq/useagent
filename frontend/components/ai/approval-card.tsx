"use client";

// The approval card (#351): one presentation, focus and keyboard model for
// every human approval decision, so the gateway tool-approval lane
// (components/chat/gateway-approval-card.tsx) and the provider-native lane
// (components/chat/native-approval-card.tsx) look and behave identically
// instead of drawing two different cards for the same choice. The lane
// wrappers own their decision semantics and lifecycle; this card owns the
// shell - header, body, footer button order, the focus-on-appear and the
// Escape (reject) / Cmd-Enter (approve) shortcuts - and renders exactly the
// actions it is handed, in the order given. It replaces the earlier
// radio-select prompt that only one lane ever used.

import { RiShieldCheckLine } from "@remixicon/react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";

export type ApprovalActionTone = "primary" | "secondary" | "ghost";

export interface ApprovalAction {
  /** Stable id; also the handle Cmd/Ctrl+Enter or Escape can target. */
  readonly id: string;
  readonly label: string;
  readonly tone: ApprovalActionTone;
  readonly onSelect: () => void;
}

export interface ApprovalChip {
  readonly color: "yellow" | "lime" | "rose" | "neutral";
  readonly label: string;
}

/**
 * The keyboard contract, pure so it is unit-tested without a DOM: Escape
 * rejects and Cmd/Ctrl+Enter approves. Returns which role the key press
 * invokes, or null when the press is not one of the two shortcuts.
 */
export function approvalShortcut(
  key: string,
  modifiers: { readonly ctrl: boolean; readonly meta: boolean },
): "approve" | "reject" | null {
  if (key === "Escape") return "reject";
  if (key === "Enter" && (modifiers.ctrl || modifiers.meta)) return "approve";
  return null;
}

export interface ApprovalCardProps {
  readonly testId: string;
  /** Lead line, e.g. "Tool approval: deploy" or "Approval required to run a command". */
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  /** Status pill (the gateway lane; native approvals carry no status). */
  readonly chip?: ApprovalChip;
  /** Structured detail: the gateway argument list or the native detail block. */
  readonly body?: ReactNode;
  /** A resolved or in-flight status line (gateway lane). */
  readonly note?: ReactNode;
  /** Actionable error, shown only while the card is still actionable. */
  readonly error?: string | null;
  /** Reason-capture row, rendered above the footer only while present (the
   *  gateway deny flow supplies it after the user chooses to deny). */
  readonly reason?: ReactNode;
  readonly actions: readonly ApprovalAction[];
  /** The action Cmd/Ctrl+Enter triggers (an approve-role button). */
  readonly approveActionId?: string;
  /** The action Escape triggers (a reject-role button). */
  readonly rejectActionId?: string;
  /** Hold keyboard focus: true only for the single pending card, so decided
   *  cards never grab focus (and a reload never scrolls to one). */
  readonly autoFocus?: boolean;
  /** Disables the footer and the shortcuts while a decision is in flight. */
  readonly busy?: boolean;
  /** Accessible name for the focusable card group. */
  readonly ariaLabel: string;
}

export function ApprovalCard({
  testId,
  title,
  subtitle,
  chip,
  body,
  note,
  error,
  reason,
  actions,
  approveActionId,
  rejectActionId,
  autoFocus = false,
  busy = false,
  ariaLabel,
}: ApprovalCardProps) {
  const ref = useRef<HTMLElement>(null);
  // Changes whenever the footer swaps (e.g. entering the deny flow), so focus
  // can be reclaimed after the previously focused button unmounts.
  const actionKey = useMemo(() => actions.map((a) => a.id).join("|"), [actions]);

  // Move focus into the card when it appears and whenever its buttons change -
  // but never steal it from wherever the user is already working (a focused
  // reason box inside this card, or another card above it). Claiming it only
  // when nothing holds it means just the one pending card ever takes focus.
  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    if (!el) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    el.focus();
  }, [autoFocus, actionKey]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (busy) return;
    const role = approvalShortcut(event.key, {
      ctrl: event.ctrlKey,
      meta: event.metaKey,
    });
    if (!role) return;
    const targetId = role === "approve" ? approveActionId : rejectActionId;
    if (!targetId) return;
    const action = actions.find((candidate) => candidate.id === targetId);
    if (!action) return;
    event.preventDefault();
    action.onSelect();
  }

  return (
    <section
      ref={ref}
      // A focusable group (role + tabIndex -1) captures Escape and Cmd-Enter
      // without hijacking the page, and shows a ring while it holds focus.
      tabIndex={-1}
      role="group"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      data-testid={testId}
      className="border-border-button-default bg-background-secondary-default space-y-3 rounded-2xl border p-4 outline-none focus:ring-2 focus:ring-border-focus-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className="bg-warning-lighter text-warning-base flex size-7 shrink-0 items-center justify-center rounded-full">
            <RiShieldCheckLine className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-body-2-medium text-text-primary">{title}</p>
            {subtitle && <p className="text-caption-1-regular text-text-tertiary">{subtitle}</p>}
          </div>
        </div>
        {chip && (
          <Chip variant="caption" color={chip.color}>
            {chip.label}
          </Chip>
        )}
      </div>

      {body}

      {note && <p className="text-caption-1-regular text-text-secondary">{note}</p>}
      {/* Both lanes send their error here, so role="alert" reads it out once (#350). */}
      {error && (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      )}

      {reason}

      {actions.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {actions.map((action) => (
            <Button
              key={action.id}
              variant={action.tone}
              size="small"
              disabled={busy}
              onClick={action.onSelect}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
