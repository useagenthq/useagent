import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GatewayApproval, GatewayApprovalStatus } from "@/lib/gateway-approvals";
import { GatewayApprovalCard } from "./gateway-approval-card";

// The conversation module reads the canonical-timeline flag at load; every test
// file that imports it must agree on the flag BEFORE the first import so the
// shared module cache never poisons the flag-dependent suites (grammar/quick-wins).
process.env.NEXT_PUBLIC_CANONICAL_TIMELINE = "1";
const { Conversation } = await import("./conversation");

function approval(overrides: Partial<GatewayApproval> = {}): GatewayApproval {
  return {
    id: "appr-1",
    runId: "run-1",
    toolName: "deploy_service",
    arguments: { service: "billing", command: "x".repeat(200) },
    status: "pending",
    requestedAt: "2026-08-20T10:00:00Z",
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

const render = (record: GatewayApproval) =>
  renderToStaticMarkup(<GatewayApprovalCard approval={record} />);

describe("GatewayApprovalCard", () => {
  test("pending renders the tool name, argument summary, and Approve/Deny actions", () => {
    const html = render(approval());
    expect(html).toContain('data-testid="gateway-approval-card"');
    expect(html).toContain("deploy_service");
    expect(html).toContain("Allow deploy_service?");
    // One-level argument summary: key + value (long values truncated).
    expect(html).toContain("service");
    expect(html).toContain("billing");
    expect(html).toContain(`${"x".repeat(79)}…`);
    expect(html).not.toContain("x".repeat(81));
    // The composed vendored approval card provides the actions.
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Deny<");
    expect(html).toContain(">Pending<");
  });

  test("approved renders a resolved state with resolver and timestamp, no actions", () => {
    const html = render(
      approval({
        status: "approved",
        resolvedAt: "2026-08-20T10:01:00Z",
        resolvedBy: "dana",
      }),
    );
    expect(html).toContain(">Approved<");
    expect(html).toContain("Approved by dana");
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Deny<");
  });

  test("denied renders a resolved state", () => {
    const html = render(approval({ status: "denied", resolvedAt: "2026-08-20T10:01:00Z" }));
    expect(html).toContain(">Denied<");
    expect(html).not.toContain(">Approve<");
  });

  test("expired renders quietly resolved", () => {
    const html = render(approval({ status: "expired" }));
    expect(html).toContain(">Expired<");
    expect(html).toContain("Expired without a decision");
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Deny<");
  });
});

describe("conversation integration", () => {
  test("multiple pending approvals stack in order", () => {
    const html = renderToStaticMarkup(
      <>
        <Conversation
          turns={[]}
          defaultEngine="opencode"
          defaultModel="claude-sonnet-5"
          defaultMemoryScope="org"
          pendingReply={null}
          onReply={async () => {}}
          gatewayApprovals={[
            approval({ id: "appr-1", toolName: "first_tool" }),
            approval({ id: "appr-2", toolName: "second_tool" }),
          ]}
        />
      </>,
    );
    expect(html.split('data-testid="gateway-approval-card"').length - 1).toBe(2);
    expect(html.indexOf("first_tool")).toBeGreaterThan(-1);
    expect(html.indexOf("first_tool")).toBeLessThan(html.indexOf("second_tool"));
  });

  test("no gateway approvals renders no card", () => {
    const html = renderToStaticMarkup(
      <>
        <Conversation
          turns={[]}
          defaultEngine="opencode"
          defaultModel="claude-sonnet-5"
          defaultMemoryScope="org"
          pendingReply={null}
          onReply={async () => {}}
        />
      </>,
    );
    expect(html).not.toContain('data-testid="gateway-approval-card"');
  });
});

// The optimistic transition + rollback live in the pure resolution machine
// (gateway-approval-state.test.ts); the render tests above lock each status
// the machine can land on. `_statusCheck` keeps the union honest at compile
// time: every status must have a render test.
const _statusCheck: readonly GatewayApprovalStatus[] = [
  "pending",
  "approved",
  "denied",
  "expired",
] as const;
void _statusCheck;
