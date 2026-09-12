import { describe, expect, test } from "bun:test";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { ArchiveBotButton } from "./archive-bot";
import { BotThreadHeader } from "./bot-details";
import { makeBot } from "./bot-fixture";
import { BotsRoster } from "./bots-roster";

const NOW = "2026-09-01T11:55:00.000Z";

/** These components call useRouter, which needs the App Router mounted. */
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as unknown as AppRouterInstance;
function renderToStaticMarkup(node: ReactNode): string {
  return renderMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);
}

function links(html: string): { name: string; describedBy: string }[] {
  return [...html.matchAll(/<a [^>]*href="\/bots\/[^"]+"[^>]*>/g)].map((match) => {
    const tag = match[0];
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(tag)?.[1] ?? "";
    const describedBy = /aria-describedby="([^"]+)"/.exec(tag)?.[1] ?? "";
    const text = (id: string) => new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1] ?? "";
    return { name: text(labelledBy), describedBy: text(describedBy) };
  });
}

describe("BotsRoster", () => {
  test("rows are ordered by state then activity, named by the bot and described by the outcome", () => {
    const html = renderToStaticMarkup(
      <BotsRoster
        initialBots={[
          makeBot({ id: "quiet", name: "Quill", lastAt: null }),
          makeBot({ id: "fresh", name: "Nova", homeThreadId: "t2", lastAt: NOW, lastOutcome: "Digest posted", handoffs: 1, handoffThreadIds: ["h1"] }),
          makeBot({ id: "hot", name: "Atlas", state: "attention", pendingApprovals: 1 }),
          makeBot({ id: "long", name: "Scout", homeThreadId: "t3", lastAt: NOW, lastOutcome: "x".repeat(300) }),
        ]}
        selectedId="fresh"
      />,
    );
    const rows = links(html);
    expect(rows.map((row) => row.name)).toEqual(["Atlas", "Nova", "Scout", "Quill"]);
    expect(rows[0]?.describedBy).toBe("Waiting for your input");
    expect(rows[1]?.describedBy).toBe("Digest posted");
    // The 300-character reply is not the accessible description; the fallback is.
    expect(rows[2]?.describedBy).toBe("Replied");
    expect(html).toContain("+1 handoff");
    expect(html).toContain("Needs you");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('title="Scout"');
    expect(html).not.toContain("rounded-xl px-3");
    // Every row leads with the bot's orb in its palette tone, never a flat fill.
    expect(html.match(/class="orb /g)).toHaveLength(4);
    expect(html).toContain('data-tone="blue"');
  });

  test("an empty roster carries the create action and the page title sits on the display ramp", () => {
    const html = renderToStaticMarkup(<BotsRoster initialBots={[]} selectedId={null} />);
    expect(html).toContain("Create bot");
    expect(html).not.toContain("No bots yet");
    expect(html).toMatch(/<h1 class="[^"]*text-display-sm[^"]*">Bots<\/h1>/);
  });
});

describe("BotThreadHeader", () => {
  test("carries the back link for the one-pane layout, the state in words and the current model", () => {
    const html = renderToStaticMarkup(<BotThreadHeader bot={makeBot({ state: "working" })} threadModel="claude-sonnet-5" />);
    expect(html).toContain('href="/bots"');
    expect(html).toContain('aria-label="All bots"');
    expect(html).toContain("md:hidden");
    expect(html).toContain("Working");
    expect(html).toContain("claude-sonnet-5");
  });

  test("an archived bot says so", () => {
    const html = renderToStaticMarkup(<BotThreadHeader bot={makeBot({ archived: true })} threadModel={null} />);
    expect(html).toContain("Archived");
  });
});

describe("ArchiveBotButton", () => {
  test("offers archive for a live bot and restore for an archived one", () => {
    expect(renderToStaticMarkup(<ArchiveBotButton bot={makeBot()} />)).toContain("Archive bot");
    expect(renderToStaticMarkup(<ArchiveBotButton bot={makeBot({ archived: true })} />)).toContain("Restore bot");
  });
});
