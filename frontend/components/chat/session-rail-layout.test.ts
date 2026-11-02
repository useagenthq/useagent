import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("session workspace rail expand mode", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  test("expands the active rail in place without remounting the panel", () => {
    const sessionView = read("./session-view.tsx");

    expect(sessionView).toContain("const [railExpanded, setRailExpanded] = useState(false)");
    expect(sessionView).toContain('railExpanded\n                  ? "flex-1 md:w-auto"');
    expect(sessionView).toContain("aria-hidden={railExpanded}");
    expect(sessionView).toContain('railExpanded && "hidden"');
    expect(sessionView).toContain("{railOpen ? (");
    expect(sessionView).toContain("<DesktopPane");
    expect(sessionView).toContain("active={desktopActive}");
  });

  test("offers explicit accessible expand and restore controls for the active tab", () => {
    const sessionView = read("./session-view.tsx");

    expect(sessionView).toContain("const railTabLabel =");
    const railTabInterpolation = "$" + "{railTabLabel}";
    expect(sessionView).toContain(`Expand ${railTabInterpolation}`);
    expect(sessionView).toContain(`Expand ${railTabInterpolation} panel to main canvas`);
    expect(sessionView).toContain(`Restore ${railTabInterpolation} panel to side rail`);
    expect(sessionView).toContain("aria-pressed={railExpanded}");
    expect(sessionView).toContain('aria-keyshortcuts={railExpanded ? "Escape" : undefined}');
    expect(sessionView).toContain('if (event.key === "Escape") setRailExpanded(false)');
  });

  test("disables resize while expanded and resets expansion before collapse", () => {
    const sessionView = read("./session-view.tsx");

    expect(sessionView).toContain("{railOpen && !railExpanded && !splitTooNarrow && (");
    expect(sessionView).toContain("if (!railOpen && railExpanded) setRailExpanded(false)");
    expect(sessionView).toContain(
      "setRailExpanded(false);\n                  setRailOverride(false);",
    );
  });

  test("floors the rail width and falls back to the sheet when the split cannot fit", () => {
    const sessionView = read("./session-view.tsx");
    const railResizer = read("./rail-resizer.tsx");

    // The side-by-side split needs the conversation floor plus the rail minimum.
    expect(railResizer).toContain("export const SPLIT_MIN = 320 + RAIL_MIN");
    expect(railResizer).toContain("setTooNarrow(width < SPLIT_MIN)");
    // The uncustomized width can never crush the terminal below its floor.
    expect(sessionView).toContain(
      '"md:w-[max(22.5rem,var(--rail-w,28.6%))] md:max-w-[calc(100%-20rem)] md:shrink-0"',
    );
    // Sheet mode = the phone breakpoint OR a measured too-narrow md+ split.
    expect(sessionView).toContain("const surfacesSheet = isMobile || splitTooNarrow");
  });

  test("makes the open sheet a named modal dialog over an inert conversation", () => {
    const sessionView = read("./session-view.tsx");

    expect(sessionView).toContain("const sheetDialogOpen = surfacesSheet && sheetSurfacesOpen");
    expect(sessionView).toContain("useSheetDialog(sheetDialogOpen, railRef, surfaceOpenerRef, closeSheet)");
    expect(sessionView).toContain('{...sheetDialogProps(sheetDialogOpen, "Side panel")}');
    expect(sessionView).toContain("inert={sheetDialogOpen}");
  });

  test("uncovers the composer when a sheet surface seeds it", () => {
    const sessionView = read("./session-view.tsx");

    // "Ask agent to redo" runs inside the sheet; the composer behind it is inert.
    expect(sessionView).toContain("if (sheetDialogOpen) closeSheet();");
    // A follow-up pick while the sheet is closed must not record a collapse: on a
    // narrow desktop window that would keep the side panel shut once it widens.
    expect(sessionView).not.toContain("if (surfacesSheet) closeSheet();");
  });

  test("keeps the opener mounted under the sheet so closing can return focus to it", () => {
    const sessionView = read("./session-view.tsx");
    const threadActions = read("./session-thread-actions.tsx");

    expect(sessionView).toContain("showSurfaceOpener={hasRuntimeSurfaces}");
    expect(sessionView).toContain("surfaceOpenerRef={surfaceOpenerRef}");
    expect(threadActions).toContain("ref={surfaceOpenerRef}");
  });

  test("keeps the screen-reader announcer outside the panes that get hidden", () => {
    const sessionView = read("./session-view.tsx");
    const conversation = read("./conversation.tsx");

    // The conversation section is hidden while the side panel is expanded and
    // inert under the phone dialog, so a live region inside it goes unheard.
    const split = sessionView.indexOf('<div ref={bodyRef} className="flex h-full min-h-0 flex-col md:flex-row">');
    const announcer = sessionView.indexOf("<ConversationAnnouncer");
    const conversationSection = sessionView.indexOf("aria-hidden={railExpanded}");
    expect(split).toBeGreaterThan(-1);
    expect(announcer).toBeGreaterThan(split);
    expect(announcer).toBeLessThan(conversationSection);
    expect(conversation).not.toContain("<ConversationAnnouncer");
  });
});
