import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { selectPendingApproval } from "./approval-state";
import { NativeApprovalCard } from "./native-approval-card";
import type { NativeFrame } from "./native-events";

function frame(seq: number, eventType: string, payload: unknown): NativeFrame {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    seq,
    provider: "t3",
    eventType,
    native: {
      sessionId: "runtime-thread-1",
      parentSessionId: null,
      messageId: null,
      partId: null,
      callId: null,
    },
    payload,
  };
}

const requested = frame(1, "approval.requested", {
  id: "approval-1",
  sessionID: "runtime-thread-1",
  requestKind: "command",
  detail: "git status",
});

const render = (props: { submitting?: boolean; error?: string | null }) => {
  const request = selectPendingApproval([requested]);
  if (!request) return "";
  return renderToStaticMarkup(
    <NativeApprovalCard
      request={request}
      submitting={props.submitting ?? false}
      error={props.error ?? null}
      onRespond={() => {}}
    />,
  );
};

describe("NativeApprovalCard", () => {
  test("pending renders the request kind, detail, and all four decisions in order", () => {
    const html = render({});
    expect(html).toContain('data-testid="native-approval-card"');
    expect(html).toContain("Approval required to run a command");
    expect(html).toContain("git status");
    expect(html).toContain(">Cancel turn<");
    expect(html).toContain(">Decline<");
    expect(html).toContain(">Always allow this session<");
    expect(html).toContain(">Approve once<");
    // Order: cancel, decline, session, approve (primary last).
    expect(html.indexOf("Cancel turn")).toBeLessThan(html.indexOf("Decline"));
    expect(html.indexOf("Decline")).toBeLessThan(html.indexOf("Always allow this session"));
    expect(html.indexOf("Always allow this session")).toBeLessThan(html.indexOf("Approve once"));
  });

  test("submitting disables the actions and shows progress on the primary", () => {
    const html = render({ submitting: true });
    expect(html).toContain(">Responding…<");
    expect(html).not.toContain(">Approve once<");
    expect(html.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  test("submission error renders the error line", () => {
    const html = render({ error: "Could not send your decision - try again" });
    expect(html).toContain("Could not send your decision - try again");
  });

  test("the card is removed once the approval resolves", () => {
    // Removal is driven by the selection: a responded frame clears the pending
    // request, so the lane renders nothing.
    const resolved = selectPendingApproval([
      requested,
      frame(2, "approval.responded", { requestId: "approval-1", decision: "accept" }),
    ]);
    expect(resolved).toBeNull();
    const html = resolved
      ? renderToStaticMarkup(
          <NativeApprovalCard
            request={resolved}
            submitting={false}
            error={null}
            onRespond={() => {}}
          />,
        )
      : "";
    expect(html).not.toContain('data-testid="native-approval-card"');
  });
});
