import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type ApprovalAction, ApprovalCard, approvalShortcut } from "./approval-card";

// The keyboard contract is pure, so it is locked here without a DOM: every
// shortcut the card binds, and every press that is NOT a shortcut. The
// interaction half (real key presses, focus, the two-step deny) lives in
// approval-card.interaction.test.tsx.
describe("approvalShortcut", () => {
  const noMods = { ctrl: false, meta: false };

  test("Escape rejects", () => {
    expect(approvalShortcut("Escape", noMods)).toBe("reject");
  });

  test("Cmd+Enter and Ctrl+Enter approve", () => {
    expect(approvalShortcut("Enter", { ctrl: false, meta: true })).toBe("approve");
    expect(approvalShortcut("Enter", { ctrl: true, meta: false })).toBe("approve");
  });

  test("a bare Enter is not a shortcut (plain typing stays safe)", () => {
    expect(approvalShortcut("Enter", noMods)).toBeNull();
  });

  test("other keys are not shortcuts", () => {
    expect(approvalShortcut("a", noMods)).toBeNull();
    expect(approvalShortcut(" ", { ctrl: true, meta: false })).toBeNull();
  });
});

const ACTIONS: ApprovalAction[] = [
  { id: "deny", label: "Deny", tone: "secondary", onSelect: () => {} },
  { id: "approve", label: "Approve", tone: "primary", onSelect: () => {} },
];

const render = (props: Partial<Parameters<typeof ApprovalCard>[0]> = {}) =>
  renderToStaticMarkup(
    <ApprovalCard
      testId="card-under-test"
      ariaLabel="Approval"
      title="Tool approval: deploy"
      actions={ACTIONS}
      approveActionId="approve"
      rejectActionId="deny"
      {...props}
    />,
  );

describe("ApprovalCard", () => {
  test("pending renders the title, actions, and a focusable group", () => {
    const html = render();
    expect(html).toContain('data-testid="card-under-test"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Approval"');
    expect(html).toContain(">Deny<");
    expect(html).toContain(">Approve<");
  });

  test("busy disables every action (the submitting state)", () => {
    const html = render({ busy: true });
    // Both footer buttons carry the native disabled attribute while in flight.
    expect(html.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("error renders the actionable error line (the submission-error state)", () => {
    const html = render({ error: "Could not send your decision - try again" });
    expect(html).toContain("Could not send your decision - try again");
    // The error line is a live alert so a screen reader hears it at once (#350).
    expect(html).toContain('role="alert"');
  });

  test("note and chip render when supplied; reason slot renders its content", () => {
    const html = render({
      note: "Approved by dana",
      chip: { color: "lime", label: "Approved" },
      reason: <span data-testid="reason-slot">reason</span>,
    });
    expect(html).toContain("Approved by dana");
    expect(html).toContain(">Approved<");
    expect(html).toContain('data-testid="reason-slot"');
  });

  test("no actions renders no footer buttons (a resolved card)", () => {
    const html = render({ actions: [] });
    expect(html).not.toContain(">Deny<");
    expect(html).not.toContain(">Approve<");
  });
});
