import { describe, expect, test } from "bun:test";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";

import { makeBot } from "@/components/bots/bot-fixture";
import { SidebarProvider } from "@/components/sidebar-kit/sidebar";
import { BotsPanel } from "./bots-panel";

const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;

function renderPanel(
  initialBots: Parameters<typeof BotsPanel>[0]["initialBots"],
  initialError = false,
) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/bots/nova">
        <SidebarProvider>
          <BotsPanel initialBots={initialBots} initialError={initialError} />
        </SidebarProvider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

describe("BotsPanel", () => {
  test("stays out of the mobile layout and offers bot creation as a button", () => {
    const html = renderPanel([makeBot({ id: "nova", name: "Nova" })]);

    expect(html).toContain("hidden w-80");
    expect(html).toContain("md:flex");
    expect(html).toMatch(/<button [^>]*aria-label="New bot"/);
    expect(html).not.toContain("/bots?new=1");
    expect(html).toContain("Nova");
  });

  test("distinguishes loading, failure, and a genuinely empty roster", () => {
    expect(renderPanel(null)).toContain("Loading bots");
    expect(renderPanel(null)).not.toContain("No bots yet");
    expect(renderPanel(null, true)).toContain("Couldn&#x27;t load bots.");
    expect(renderPanel([])).toContain("No bots yet");
  });

  test("keeps the last good roster visible when a refresh fails", () => {
    const html = renderPanel([makeBot({ id: "nova", name: "Nova" })], true);

    expect(html).toContain("Nova");
    expect(html).toContain("Couldn&#x27;t refresh bots.");
    expect(html).toContain("Try again");
  });
});
