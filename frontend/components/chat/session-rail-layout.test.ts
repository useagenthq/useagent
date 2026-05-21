import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("session workspace rail expand mode", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  test("expands the active rail in place without remounting the panel", () => {
    const sessionView = read("./session-view.tsx");

    expect(sessionView).toContain("const [railExpanded, setRailExpanded] = useState(false)");
    expect(sessionView).toContain('railExpanded\n                ? "flex-1 md:w-auto"');
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

    expect(sessionView).toContain("{railOpen && !railExpanded && (");
    expect(sessionView).toContain("if (!railOpen && railExpanded) setRailExpanded(false)");
    expect(sessionView).toContain(
      "setRailExpanded(false);\n                  setRailOverride(false);",
    );
  });
});
