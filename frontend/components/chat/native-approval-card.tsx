"use client";

import { RiShieldCheckLine } from "@remixicon/react";
import * as Button from "@/components/ui/button";
import type { ApprovalDecision, PendingApproval } from "./approval-state";

export function NativeApprovalCard({
  request,
  submitting,
  error,
  onRespond,
}: {
  request: PendingApproval;
  submitting: boolean;
  error: string | null;
  onRespond: (decision: ApprovalDecision) => void | Promise<void>;
}) {
  const action =
    request.requestKind === "command"
      ? "run a command"
      : request.requestKind === "file-read"
        ? "read a file"
        : request.requestKind === "file-change"
          ? "change files"
          : "use a tool";
  return (
    <section
      className="border-stroke-soft-200 bg-bg-weak-50 space-y-3 rounded-2xl border p-4"
      data-testid="native-approval-card"
    >
      <div className="flex items-start gap-2">
        <span className="bg-warning-alpha-10 text-warning-base flex size-7 shrink-0 items-center justify-center rounded-full">
          <RiShieldCheckLine className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-label-sm text-text-strong-950">Approval required to {action}</p>
          {request.detail && (
            <pre className="text-paragraph-xs text-text-sub-600 mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">
              {request.detail}
            </pre>
          )}
        </div>
      </div>
      {error && <p className="text-paragraph-xs text-error-base">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button.Root
          variant="neutral"
          mode="ghost"
          size="small"
          disabled={submitting}
          onClick={() => void onRespond("cancel")}
        >
          Cancel turn
        </Button.Root>
        <Button.Root
          variant="error"
          mode="stroke"
          size="small"
          disabled={submitting}
          onClick={() => void onRespond("decline")}
        >
          Decline
        </Button.Root>
        <Button.Root
          variant="neutral"
          mode="stroke"
          size="small"
          disabled={submitting}
          onClick={() => void onRespond("acceptForSession")}
        >
          Always allow this session
        </Button.Root>
        <Button.Root
          variant="primary"
          mode="filled"
          size="small"
          disabled={submitting}
          onClick={() => void onRespond("accept")}
        >
          {submitting ? "Responding…" : "Approve once"}
        </Button.Root>
      </div>
    </section>
  );
}
