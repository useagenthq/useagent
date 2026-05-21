import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  resolveThreadRowClassName,
  resolveThreadRowPill,
  threadRowTimestamp,
} from "./thread-row";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("thread status pill (upstream running/failed/settled treatment)", () => {
  test("running threads read Working with a pulsing dot", () => {
    const pill = resolveThreadRowPill({ status: "running" });
    expect(pill?.label).toBe("Working");
    expect(pill?.dot.pulse).toBe(true);
  });

  test("every live wire status maps to Working", () => {
    for (const status of ["running", "active", "in_progress", "live", "streaming"]) {
      expect(resolveThreadRowPill({ status })?.label).toBe("Working");
    }
  });

  test("failed threads read Failed with a steady error dot", () => {
    const pill = resolveThreadRowPill({ status: "failed" });
    expect(pill?.label).toBe("Failed");
    expect(pill?.dot.tone).toBe("error");
    expect(pill?.dot.pulse).toBeUndefined();
    expect(pill?.textClass).toBe("text-error-base");
  });

  test("cancelled counts as Failed", () => {
    expect(resolveThreadRowPill({ status: "cancelled" })?.label).toBe("Failed");
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

  test("queued and unknown statuses rest unlabeled", () => {
    expect(resolveThreadRowPill({ status: "queued" })).toBeNull();
    expect(resolveThreadRowPill({ status: "pending", unread: true })).toBeNull();
    expect(resolveThreadRowPill({ status: "who-knows" })).toBeNull();
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
    expect(className).toContain("bg-bg-weak-50");
    expect(className).toContain("font-medium");
    expect(className).toContain("text-text-strong-950");
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
    expect(className).toContain("hover:bg-bg-weak-50");
    expect(className).toContain("hover:text-text-strong-950");
    expect(className).toContain("text-text-sub-600");
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
  test("the thread sidebar renders the t3 thread list, not the old recents rows", () => {
    const threadSidebar = read("../shell/thread-sidebar.tsx");
    expect(threadSidebar).toContain("<SidebarThreads");
    expect(threadSidebar).not.toContain("SidebarRecents");
  });

  test("the thread list binds the t3 row to the existing runs lane", () => {
    const list = read("../shell/sidebar-threads.tsx");
    expect(list).toContain("<T3ThreadRow");
    expect(list).toContain("fetchRuns");
    expect(list).toContain("useOrgChanges");
    expect(list).toContain("usePathname");
    expect(list).toContain(">Threads<");
  });

  test("the row keeps the ported presentation surface", () => {
    const row = read("./thread-row.tsx");
    expect(row).toContain('data-t3-ui="thread-row"');
    expect(row).toContain("truncate");
    expect(row).toContain("aria-current");
    expect(row).toContain("<StatusDot");
    expect(row).toContain("tabular-nums");
  });
});
