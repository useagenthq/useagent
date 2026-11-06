// The interaction half of the approval-card tests: register happy-dom's
// globals BEFORE react-dom/client loads, mount the real lane wrappers, press
// keys and click buttons, and read focus and the resulting layout off the live
// DOM. The static-markup tests beside this file lock what renders; these lock
// what the keyboard and the two-step deny actually do.
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

// Tell React these tests drive it through act(), so state flushes synchronously.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// react-aria (the reason Input) touches a couple of browser APIs happy-dom
// does not ship; stub the ones it reaches during mount.
if (typeof HTMLElement !== "undefined" && !("scrollIntoView" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    value: () => {},
    configurable: true,
    writable: true,
  });
}
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (media: string) =>
    ({
      matches: false,
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NativeApprovalCard } = await import("../chat/native-approval-card");
const { GatewayApprovalCard } = await import("../chat/gateway-approval-card");

import type { ReactElement } from "react";
import type { GatewayApproval } from "@/lib/gateway-approvals";
import type { PendingApproval } from "../chat/approval-state";

let roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

function mount(ui: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  roots.push({ root, container });
  return container;
}

afterEach(() => {
  for (const { root, container } of roots) {
    act(() => root.unmount());
    container.remove();
  }
  roots = [];
  (document.activeElement as HTMLElement | null)?.blur?.();
});

function press(el: Element, key: string, mods: { ctrl?: boolean; meta?: boolean } = {}) {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ctrlKey: !!mods.ctrl,
        metaKey: !!mods.meta,
      }),
    );
  });
}

function button(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;
}

const request: PendingApproval = {
  id: "n1",
  sessionId: "s",
  requestKind: "command",
  detail: "git status",
};

function approval(overrides: Partial<GatewayApproval> = {}): GatewayApproval {
  return {
    id: "g1",
    runId: "r1",
    toolName: "deploy_service",
    arguments: { service: "billing" },
    status: "pending",
    requestedAt: "2026-01-01T00:00:00Z",
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

describe("native approval card interaction", () => {
  test("takes focus on appear, and the keyboard approves and declines", () => {
    const decisions: string[] = [];
    const container = mount(
      <NativeApprovalCard
        request={request}
        submitting={false}
        error={null}
        onRespond={(d) => {
          decisions.push(d);
        }}
      />,
    );
    const card = container.querySelector('[data-testid="native-approval-card"]');
    if (!card) throw new Error("native card did not render");
    expect(document.activeElement).toBe(card);

    press(card, "Enter", { meta: true });
    expect(decisions).toContain("accept");

    press(card, "Escape");
    expect(decisions).toContain("decline");
  });
});

describe("gateway approval card interaction", () => {
  test("a decided card never takes focus", () => {
    mount(
      <GatewayApprovalCard
        approval={approval({
          status: "approved",
          resolvedAt: "2026-01-01T00:01:00Z",
          resolvedBy: "dana",
        })}
      />,
    );
    expect(document.activeElement).toBe(document.body);
  });

  test("two-step deny: Escape opens the reason box and focuses it; Keep reviewing returns focus", () => {
    const container = mount(<GatewayApprovalCard approval={approval()} />);
    const card = container.querySelector('[data-testid="gateway-approval-card"]') as HTMLElement;
    expect(document.activeElement).toBe(card);
    // No reason box until the user chooses to deny.
    expect(card.querySelector('[aria-label="Reason for denying"]')).toBeNull();

    // Escape enters the deny flow; focus moves to the reason box.
    press(card, "Escape");
    const reason = card.querySelector('[aria-label="Reason for denying"]');
    expect(reason).not.toBeNull();
    expect(document.activeElement).toBe(reason);
    expect(button(container, "Keep reviewing")).toBeTruthy();

    // Backing out removes the reason box and returns focus to the card, so the
    // shortcuts keep working.
    act(() => button(container, "Keep reviewing")?.click());
    expect(card.querySelector('[aria-label="Reason for denying"]')).toBeNull();
    expect(document.activeElement).toBe(card);
  });
});
