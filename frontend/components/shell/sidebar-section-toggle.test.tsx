import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarSectionToggle } from "./sidebar-nav";

describe("sidebar section toggle", () => {
  test("is a real button that announces its open state and what it controls", () => {
    const open = renderToStaticMarkup(
      <SidebarSectionToggle open onToggle={() => {}} controls="sidebar-threads-section">
        Threads
      </SidebarSectionToggle>,
    );
    expect(open).toContain('<button type="button"');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('aria-controls="sidebar-threads-section"');
    expect(open).toContain(">Threads</span>");
    expect(open).not.toContain("-rotate-90");

    const folded = renderToStaticMarkup(
      <SidebarSectionToggle open={false} onToggle={() => {}}>
        Projects
      </SidebarSectionToggle>,
    );
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toContain("-rotate-90");
  });
});
