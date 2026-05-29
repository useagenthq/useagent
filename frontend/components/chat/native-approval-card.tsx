"use client";

import { RiShieldCheckLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
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
      className="border-border-button-default bg-background-secondary-default space-y-3 rounded-2xl border p-4"
      data-testid="native-approval-card"
    >
      <div className="flex items-start gap-2">
        <span className="bg-yellow-500/10 text-yellow-600 flex size-7 shrink-0 items-center justify-center rounded-full">
          <RiShieldCheckLine className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-body-2-medium text-text-primary">Approval required to {action}</p>
          {request.detail && (
            <pre className="text-caption-1-regular text-text-secondary mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">
              {request.detail}
            </pre>
          )}
        </div>
      </div>
      {error && <p className="text-caption-1-regular text-red-500">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          size="small"
          disabled={submitting}
          onClick={() => void onRespond("cancel")}
        >
          Cancel turn
        </Button>
        <Button
          variant="danger"
          size="small"
          disabled={submitting}
          onClick={() => void onRespond("decline")}
        >
          Decline
        </Button>
        <Button
          variant="secondary"
          size="small"
          disabled={submitting}
          onClick={() => void onRespond("acceptForSession")}
        >
          Always allow this session
        </Button>
        <Button
          variant="primary"
          size="small"
          disabled={submitting}
          onClick={() => void onRespond("accept")}
        >
          {submitting ? "Responding…" : "Approve once"}
        </Button>
      </div>
    </section>
  );
}
