import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { resolveThreadRowClassName, resolveThreadRowPill, threadRowTimestamp } from "./thread-row";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("thread status pill (upstream running/failed/settled treatment)", () => {
  test("running threads read Working with a pulsing dot", () => {
    const pill = resolveThreadRowPill({ status: "running" });
    expect(pill?.label).toBe("Working");
    expect(pill?.dot.pulse).toBe(true);
  });

  test("failed threads read Failed with a steady error dot", () => {
    const pill = resolveThreadRowPill({ status: "failed" });
    expect(pill?.label).toBe("Failed");
    expect(pill?.dot.tone).toBe("error");
    expect(pill?.dot.pulse).toBeUndefined();
    expect(pill?.textClass).toBe("text-text-error-primary");
  });

  test("failure stays visible even when marked unread", () => {
    expect(resolveThreadRowPill({ status: "failed", unread: true })?.label).toBe("Failed");
  });

  test("unread completion is the only settled pill (unread affordance)", () => {
    const pill = resolveThreadRowPill({ status: "completed", unread: true });
    expect(pill?.label).toBe("Completed");
    expect(pill?.dot.tone).toBe("success");
  });

  test("a seen completion rests unlabeled (inbox-zero)", () => {
    expect(resolveThreadRowPill({ status: "completed" })).toBeNull();
  });

  test("queued threads rest unlabeled", () => {
    expect(resolveThreadRowPill({ status: "queued" })).toBeNull();
  });
});

describe("row density (upstream resolveThreadRowClassName)", () => {
  test("rows are compact fixed-height hover targets", () => {
    for (const active of [true, false]) {
      const className = resolveThreadRowClassName({ active });
      expect(className).toContain("h-8");
      expect(className).toContain("px-2.5");
      expect(className).toContain("select-none");
    }
  });

  test("active rows hold their fill and weight", () => {
    const className = resolveThreadRowClassName({ active: true });
    expect(className).toContain("bg-background-secondary-default");
    expect(className).toContain("font-medium");
    expect(className).toContain("text-text-primary");
  });

  test("a git line trades the fixed height for a two-line column", () => {
    for (const active of [true, false]) {
      const className = resolveThreadRowClassName({ active, gitLine: true });
      expect(className).toContain("flex-col");
      expect(className).toContain("py-1.5");
      expect(className).not.toContain("h-8");
      expect(className).toContain("px-2.5");
      expect(className).toContain("select-none");
    }
  });

  test("resting rows brighten on hover only", () => {
    const className = resolveThreadRowClassName({ active: false });
    expect(className).toContain("hover:bg-background-primary-hover");
    expect(className).toContain("hover:text-text-primary");
    expect(className).toContain("text-text-secondary");
    expect(className).not.toContain("font-medium");
  });
});

describe("trailing timestamp pick", () => {
  test("prefers updated_at over created_at", () => {
    expect(
      threadRowTimestamp({
        updated_at: "2026-08-17T10:00:00Z",
        created_at: "2026-08-16T10:00:00Z",
      }),
    ).toBe(Date.parse("2026-08-17T10:00:00Z"));
  });

  test("a malformed updated_at falls through to created_at", () => {
    expect(
      threadRowTimestamp({ updated_at: "not-a-date", created_at: "2026-08-16T10:00:00Z" }),
    ).toBe(Date.parse("2026-08-16T10:00:00Z"));
  });

  test("accepts epoch-ms numbers", () => {
    expect(threadRowTimestamp({ updated_at: 1_755_000_000_000 })).toBe(1_755_000_000_000);
  });

  test("returns null when nothing valid exists", () => {
    expect(threadRowTimestamp({})).toBeNull();
    expect(threadRowTimestamp({ updated_at: Number.NaN, created_at: null })).toBeNull();
  });
});

describe("sidebar wiring contract", () => {
  test("the thread sidebar nests threads under project groups, not the old recents rows", () => {
    const threadSidebar = read("../shell/thread-sidebar.tsx");
    expect(threadSidebar).toContain("<SidebarProjects");
    expect(threadSidebar).not.toContain("SidebarRecents");
  });

  test("the project rail renders the native tree bound to the existing runs + repos lanes", () => {
    const tree = read("./project-thread-tree.tsx");
    const projects = read("../shell/sidebar-projects.tsx");
    // Threads nest under their project through the native tree treatment
    // (curved connector + relative-time chips), not a flat recents list.
    expect(tree).toContain("ProjectThreadTree");
    expect(tree).toContain("TreeConnector");
    expect(projects).toContain("<ProjectThreadTree");
    expect(projects).toContain("usePathname");
    // The data owner reuses the existing runs + repos lanes - no new endpoint.
    expect(projects).toContain("fetchSidebarRuns");
    expect(projects).toContain("useOrgChanges");
    expect(projects).toContain('backendFetch("/api/repos"');
    expect(projects).toContain("groupThreadsByProject");
    expect(projects).toContain(">Projects<");
  });

  test("the row keeps the ported presentation surface", () => {
    const row = read("./thread-row.tsx");
    expect(row).toContain('data-session-ui="thread-row"');
    expect(row).toContain("truncate");
    expect(row).toContain("aria-current");
    expect(row).toContain("<StatusDot");
    expect(row).toContain("tabular-nums");
  });
});
