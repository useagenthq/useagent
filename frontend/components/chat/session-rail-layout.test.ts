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
    expect(sessionView).toContain("<DesktopPane threadId={rootId} />");
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
});
