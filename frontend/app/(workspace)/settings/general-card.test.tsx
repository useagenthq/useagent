import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { activeWorkspace, GeneralCard } from "./general-card";

const acme = { id: "org-1", name: "Acme Robotics" };

test("the General card shows the workspace's own name, as renamed, not a placeholder", () => {
  const html = renderToStaticMarkup(<GeneralCard initialWorkspace={{ ...acme, role: "member" }} />);
  expect(html).toContain("Workspace name");
  expect(html).toContain("Acme Robotics");
  expect(html).not.toContain(">UseAgent<");
});

test("while the workspace list loads the row shows nothing rather than a wrong name", () => {
  const html = renderToStaticMarkup(<GeneralCard />);
  expect(html).toContain("Workspace name");
  expect(html).not.toContain("Not set");
  expect(html).not.toContain(">UseAgent<");
  expect(html).not.toContain("<input");
});

test("a member sees the workspace name as text, with no field or Save", () => {
  const html = renderToStaticMarkup(<GeneralCard initialWorkspace={{ ...acme, role: "member" }} />);
  expect(html).toContain(">Acme Robotics</p>");
  expect(html).not.toContain("<input");
  expect(html).not.toContain(">Save<");
});

test("an owner or an admin gets the name in a field with Save", () => {
  for (const role of ["owner", "admin"] as const) {
    const html = renderToStaticMarkup(<GeneralCard initialWorkspace={{ ...acme, role }} />);
    expect(html).toContain('aria-label="Workspace name"');
    expect(html).toContain('value="Acme Robotics"');
    expect(html).toContain(">Save<");
    expect(html).not.toContain(">Acme Robotics</p>");
  }
});

test("a list without the session's workspace is a failed read, not an unset name", () => {
  expect(activeWorkspace([{ id: "org-1", name: "Acme", role: "owner", active: false }])).toBeNull();
  expect(activeWorkspace([])).toBeNull();
  expect(activeWorkspace([{ id: "org-1", name: "Acme", role: "admin", active: true }])).toEqual({
    id: "org-1",
    name: "Acme",
    role: "admin",
  });
});
