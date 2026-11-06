import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRailTabs } from "./session-rail-tabs";
import { railPanelName, railTabLabelFor } from "./surface-chooser";

describe("SessionRailTabs", () => {
  test("Details is a stable surface beside Files, Editor, Terminal and Browser", () => {
    const html = renderToStaticMarkup(
      <SessionRailTabs
        railTab="details"
        hasSubagents={false}
        hasWorkspace={false}
        hasFiles={false}
        onSelect={() => {}}
      />,
    );
    for (const id of ["artifacts", "editor", "terminal", "desktop", "details"]) {
      expect(html).toContain(`data-testid="rail-tab-${id}"`);
    }
    for (const id of ["agents", "workspace", "diff"]) {
      expect(html).not.toContain(`data-testid="rail-tab-${id}"`);
    }
    expect(html).toContain(">Details<");
    const details = html.split("<button").find((chunk) => chunk.includes('rail-tab-details')) ?? "";
    expect(details).toContain('aria-pressed="true"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(railTabLabelFor("details")).toBe("Details");
  });

  test("the expand control names the open panel, or just the panel while none is chosen", () => {
    expect(railPanelName("artifacts")).toBe("Files panel");
    expect(railPanelName("desktop")).toBe("Browser panel");
    expect(railPanelName(null)).toBe("panel");
  });

  test("Agents, Workspace and Diff appear only once the thread has them", () => {
    const html = renderToStaticMarkup(
      <SessionRailTabs railTab={null} hasSubagents hasWorkspace hasFiles onSelect={() => {}} />,
    );
    expect(html.match(/data-testid="rail-tab-/g)).toHaveLength(8);
    expect(html.indexOf('rail-tab-agents')).toBeLessThan(html.indexOf('rail-tab-artifacts'));
  });
});
