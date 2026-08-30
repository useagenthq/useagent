import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { OrgChange } from "@/lib/org-changes";
import {
  refreshesSidebarThreads,
  SidebarThreadsProvider,
  useSidebarThreads,
} from "./sidebar-threads-provider";

function Probe(): ReactNode {
  return <span data-count={useSidebarThreads().length} />;
}

test("the AppShell provider supplies one shared initial snapshot to consumers", () => {
  expect(
    renderToStaticMarkup(
      <SidebarThreadsProvider>
        <Probe />
      </SidebarThreadsProvider>,
    ),
  ).toContain('data-count="0"');
});

test("every run lifecycle invalidation and fired automation refreshes the snapshot", () => {
  for (const action of ["created", "running", "settled", "cancelled"] as const) {
    const change: OrgChange = { type: "run", action, runId: "run-1", threadId: "thread-1" };
    expect(refreshesSidebarThreads(change)).toBe(true);
  }
  expect(
    refreshesSidebarThreads({
      type: "automation",
      action: "fired",
      automationId: "automation-1",
      runId: "run-1",
    }),
  ).toBe(true);
  expect(
    refreshesSidebarThreads({
      type: "automation",
      action: "updated",
      automationId: "automation-1",
    }),
  ).toBe(false);
});
