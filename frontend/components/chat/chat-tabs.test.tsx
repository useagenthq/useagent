import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTabStrip, tabKeyAction } from "./chat-tabs";

const TABS = [
  { id: "r1", title: "Fix the login bug", href: "/session/r1", engine: "codex", status: "running" as const },
  { id: "r2", title: "Deploy to staging", href: "/session/r2", engine: "claude", status: "failed" as const },
  { id: "r3", title: "Write the release notes", href: "/session/r3", engine: "opencode", status: "completed" as const },
];

describe("ChatTabStrip", () => {
  test("nothing renders until a chat is open", () => {
    expect(renderToStaticMarkup(<ChatTabStrip tabs={[]} activeId={null} onClose={() => {}} />)).toBe("");
  });

  test("one tab per open chat, the current one selected, each closable", () => {
    const html = renderToStaticMarkup(<ChatTabStrip tabs={TABS} activeId="r2" onClose={() => {}} />);
    expect(html).toContain('data-testid="chat-tabs"');
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('href="/session/r1"');
    expect(html).toContain(">Deploy to staging<");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-label="Close Fix the login bug"');
    const selected = html.match(/<a[^>]*aria-selected="true"[^>]*>/g) ?? [];
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('href="/session/r2"');
    // The tablist owns its tabs through aria-owns (each capsule also carries a
    // close mark, which cannot be a tablist child or nest in the tab link).
    const tablist = html.match(/<div[^>]*role="tablist"[^>]*>/)?.[0] ?? "";
    expect(tablist).toContain(`aria-owns="${TABS.map((t) => t.id).join(" ")}"`);
    for (const tab of TABS) expect(html).toContain(`id="${tab.id}"`);
  });

  test("tabs are capsules with the engine mark, a status dot in the rail's states and a plus for a new chat", () => {
    const html = renderToStaticMarkup(<ChatTabStrip tabs={TABS} activeId="r2" onClose={() => {}} />);
    // The strip has no bottom border; every tab is a rounded-full pill.
    const strip = html.match(/<div[^>]*role="tablist"[^>]*>/)?.[0] ?? "";
    expect(strip).not.toContain("border-b");
    expect(html.match(/role="presentation"[^>]*class="[^"]*rounded-full/g)).toHaveLength(3);
    // The status dot reads the same states as the rail rows: running, failed, done.
    expect(html).toContain('aria-label="Running"');
    expect(html).toContain('aria-label="Failed"');
    expect(html).toContain('aria-label="Completed"');
    expect(html).toContain("bg-red-500");
    // A tab whose thread the rail list does not hold yet shows no dot at all:
    // an unknown state must not read as done.
    const unknown = renderToStaticMarkup(
      <ChatTabStrip tabs={[{ id: "r9", title: "Chat", href: "/session/r9" }]} activeId="r9" onClose={() => {}} />,
    );
    expect(unknown).not.toContain('role="img"');
    expect(unknown).not.toContain("Completed");
    // A vendor mark per engine (the knot for Codex, the starburst for Claude), decorative.
    expect(html).toContain("M22.2819 9.8211");
    expect(html).toContain("m4.7144 15.9555");
    // The plus at the end opens a new chat.
    const plus = html.match(/<a[^>]*aria-label="New chat"[^>]*>/)?.[0] ?? "";
    expect(plus).toContain('href="/agent/new"');
    // The close mark shows on the current tab and stays hidden (until hover) elsewhere.
    const closes = html.match(/<button[^>]*aria-label="Close [^"]*"[^>]*>/g) ?? [];
    expect(closes).toHaveLength(3);
    expect(closes[1]).toContain("opacity-100");
    expect(closes[0]).toContain("opacity-0");
  });
});

describe("tabKeyAction", () => {
  test("arrow keys move focus between tabs and wrap at both ends", () => {
    expect(tabKeyAction("ArrowRight", 0, 3)).toEqual({ focus: 1 });
    expect(tabKeyAction("ArrowRight", 2, 3)).toEqual({ focus: 0 });
    expect(tabKeyAction("ArrowLeft", 0, 3)).toEqual({ focus: 2 });
    expect(tabKeyAction("ArrowLeft", 1, 3)).toEqual({ focus: 0 });
  });

  test("Delete and Backspace close the focused tab; other keys and an unfocused strip do nothing", () => {
    expect(tabKeyAction("Delete", 1, 3)).toEqual({ close: true });
    expect(tabKeyAction("Backspace", 0, 3)).toEqual({ close: true });
    expect(tabKeyAction("Enter", 1, 3)).toBeNull();
    expect(tabKeyAction("ArrowRight", -1, 3)).toBeNull();
    expect(tabKeyAction("Delete", 0, 0)).toBeNull();
  });
});
