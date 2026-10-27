// Checks the mapping ConversationAnnouncer adds on top of the pure rule:
// completed turn -> reply, user cancel -> stop, real failure -> silent (the
// error banner handles that one).
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConversationAnnouncer } = await import("./conversation-announcer");

import type { GatewayApproval } from "@/lib/gateway-approvals";
import type { Turn } from "./conversation";
import type { ApiRun, RunStatus } from "./types";

// The announcer reads only status, summary and the root run id, so the rest of
// the Turn shape is irrelevant here.
function turn(id: string, status: RunStatus, summary: string | null): Turn {
  return {
    run: { id } as unknown as ApiRun,
    steps: [],
    status,
    summary,
    live: status === "running",
    liveText: "",
    liveReasoning: "",
  };
}

function gateway(id: string, status: GatewayApproval["status"]): GatewayApproval {
  return {
    id,
    runId: "r1",
    toolName: "deploy_service",
    arguments: {},
    status,
    requestedAt: "2026-01-01T00:00:00Z",
    resolvedAt: null,
    resolvedBy: null,
  };
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

type Props = Parameters<typeof ConversationAnnouncer>[0];

const RUNNING: Props = {
  running: true,
  turns: [turn("root", "running", null)],
  pendingApproval: null,
  pendingQuestion: null,
  gatewayApprovals: [],
};

function mount(props: Props) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ConversationAnnouncer {...props} />));
}

function rerender(props: Props) {
  act(() => root?.render(<ConversationAnnouncer {...props} />));
}

function text(): string {
  return (container?.querySelector('[role="status"]')?.textContent ?? "").trim();
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("ConversationAnnouncer mapping", () => {
  test("a completed turn is announced as a reply", () => {
    mount(RUNNING);
    rerender({ ...RUNNING, running: false, turns: [turn("root", "completed", "Done.")] });
    expect(text()).toBe("The agent replied.");
  });

  test("a user stop is announced as a stop, not a reply", () => {
    mount(RUNNING);
    rerender({
      ...RUNNING,
      running: false,
      turns: [turn("root", "failed", "Stopped by user before the first tool call.")],
    });
    expect(text()).toBe("The agent stopped.");
  });

  test("a real failure stays silent (the error banner owns it)", () => {
    mount(RUNNING);
    rerender({
      ...RUNNING,
      running: false,
      turns: [turn("root", "failed", "The model returned an error.")],
    });
    expect(text()).toBe("");
  });

  test("a newly pending gateway approval is announced", () => {
    mount(RUNNING);
    rerender({ ...RUNNING, gatewayApprovals: [gateway("g1", "pending")] });
    expect(text()).toBe("The agent needs your approval.");
  });
});
