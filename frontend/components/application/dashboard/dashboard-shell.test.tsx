import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardShell } from "./dashboard-shell";

describe("DashboardShell", () => {
  test("renders the desktop dashboard sidebar edge-to-edge", () => {
    const html = renderToStaticMarkup(<DashboardShell />);

    expect(html).toContain("sticky top-0 z-10 hidden shrink-0 lg:block");
    expect(html).toContain("h-dvh");
    expect(html).not.toContain("sticky top-3");
    expect(html).not.toContain(
      "rounded-3xl border border-border-button-white bg-background-secondary-default shadow-sidebar",
    );
  });
});
